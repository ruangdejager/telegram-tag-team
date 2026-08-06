import TelegramBot from 'node-telegram-bot-api';
import { appConfig } from './config.js';
import { buildSimpleKeyboard, buildFullKeyboard } from './keyboard.js';
import { fetchHistorySessions } from './history.js';
import { formatSessionMessage, formatTimeoutAlert, formatLatestCount, formatBatteryStatusList } from './formatter.js';
import { groupSessionsByDate, formatDailySummary } from './dailySummary.js';
import { buildTagSeries } from './analytics.js';
import { sendBatteryChart, sendBatteryTrendChart } from './charts.js';
import { sendPositionMap, sendHeatmap } from './maps.js';
import { createSubscriberStore } from './subscribers.js';
import { createStateStore } from './state.js';
import { findMissingTags, formatMissingTags, formatMissingTagsInline } from './missingTags.js';
import { findLatestGpsForTag, findTagLastSeen, formatTagGps } from './tagGps.js';
import { parseTagIdList, jhbMidnightMsDaysAgo } from './utils.js';
import { fetchUnitLogText } from './apiClient.js';
import { parseLogText } from './logParser.js';
import { mergeSessions } from './sessionMerger.js';

const BATTERY_TREND_DAYS = 7;
const HEATMAP_DEFAULT_DAYS = 3;
const MISSING_TAGS_WINDOW_HOURS = 7 * 24;

// Parses /heatmap args into a { fromMs, toMs, label } window.
// Accepts:  ""            -> default 3 days
//           "5d" / "5"    -> last N days
//           "YYYY-MM-DD YYYY-MM-DD"  -> explicit inclusive-to-end-of-day range
// Returns { error: string } on parse failure.
function parseHeatmapArgs(input) {
  const parts = String(input || '').trim().split(/\s+/).filter(Boolean);
  const now = Date.now();
  if (parts.length === 0) {
    return { fromMs: now - HEATMAP_DEFAULT_DAYS * 24 * 60 * 60 * 1000, toMs: now, label: `last ${HEATMAP_DEFAULT_DAYS}d` };
  }
  if (parts.length === 1) {
    const m = parts[0].match(/^(\d+)d?$/i);
    if (!m) return { error: 'Expected <code>Nd</code> (e.g. <code>5d</code>) or <code>YYYY-MM-DD YYYY-MM-DD</code>' };
    const days = parseInt(m[1], 10);
    if (days <= 0) return { error: 'Days must be a positive integer.' };
    return { fromMs: now - days * 24 * 60 * 60 * 1000, toMs: now, label: `last ${days}d` };
  }
  if (parts.length === 2) {
    const from = new Date(parts[0] + 'T00:00:00+02:00');
    const to = new Date(parts[1] + 'T23:59:59+02:00');
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { error: 'Invalid date. Use <code>YYYY-MM-DD YYYY-MM-DD</code>.' };
    if (from > to) return { error: 'From-date must be on or before to-date.' };
    return { fromMs: from.getTime(), toMs: to.getTime(), label: `${parts[0]} → ${parts[1]}` };
  }
  return { error: 'Too many arguments. Use <code>Nd</code> or <code>YYYY-MM-DD YYYY-MM-DD</code>.' };
}
const FETCH_BUFFER_MINUTES = 10; // re-fetch a little before lastProcessedTimestamp to catch late cross-device blocks

// One running bot: owns its Telegram connection, per-chat prompt state, per-bot
// state + subscriber stores, and level-aware handlers. `botConfig` = { id, name,
// token, level, unitIds, adminChatId }.
//
// Every handler below takes `bot` as an explicit parameter rather than reading a
// shared mutable variable — event listeners are registered with the *specific*
// TelegramBot instance captured at start() time, so if stop()/restart() swaps or
// clears the runtime's tracked instance while an already-fired event is still being
// handled, that in-flight call keeps using the real (still-usable-for-API-calls)
// instance instead of crashing on a null reference.
export function createBotRuntime(botConfig) {
  const { id, name, token, level, unitIds, adminChatId } = botConfig;
  const isClient = level === 'client';
  const stateStore = createStateStore(id);
  const subStore = createSubscriberStore(id, adminChatId);
  const pendingByChat = new Map(); // chatId -> { action: 'batt_trend' | 'gps' }

  let activeBot = null; // only used by start()/stop()/pollOnce(), never by event handlers
  let state = { lastProcessedTimestamp: null };

  const welcome =
    `🐄 <b>${name}</b>\n\n` +
    'Use the buttons below to query tag discovery history, or opt in to receive live updates whenever new tags are detected.\n\n' +
    (isClient
      ? 'Commands: <code>/gps ID</code>, <code>/missing</code>, <code>/heatmap [Nd | YYYY-MM-DD YYYY-MM-DD]</code>'
      : `Commands: <code>/battery ID [ID ...]</code> or <code>/battery *</code> (${BATTERY_TREND_DAYS}d trend, per tag or all), <code>/gps ID</code>, <code>/missing</code>, <code>/heatmap [Nd | YYYY-MM-DD YYYY-MM-DD]</code>`);

  async function sendMessage(bot, chatId, text) {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
  }

  // Attaches the simple default screen (Latest Count + Menu) unless `full` is set —
  // the opted-in live push and the "Menu" button itself are the only two places that
  // ask for the complete button list; everything else falls back to the simple screen.
  async function sendWithButtons(bot, chatId, text, subscribed, { full = false } = {}) {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: full ? buildFullKeyboard(subscribed, level) : buildSimpleKeyboard(),
    });
  }

  async function handleMessage(bot, message) {
    const chatId = String(message.chat.id);
    const subscribed = subStore.isOptedIn(chatId);
    const text = (message.text || '').trim();

    if (text.startsWith('/start')) {
      pendingByChat.delete(chatId);
      await sendWithButtons(bot, chatId, welcome, subscribed);
      return;
    }
    if (text.startsWith('/battery')) {
      if (isClient) {
        await sendWithButtons(bot, chatId, 'ℹ️ Battery trend is not available on this bot. Use the 🔋 Battery button.', subscribed);
        return;
      }
      await runBatteryTrend(bot, chatId, subscribed, text.replace(/^\/battery\s*/i, ''));
      return;
    }
    if (text.startsWith('/gps')) {
      await runGpsLookup(bot, chatId, subscribed, text.replace(/^\/gps\s*/i, ''));
      return;
    }
    if (text.startsWith('/missing')) {
      await runMissingTags(bot, chatId, subscribed);
      return;
    }
    if (text.startsWith('/heatmap')) {
      await runHeatmap(bot, chatId, subscribed, text.replace(/^\/heatmap\s*/i, ''));
      return;
    }
    if (text.startsWith('/map')) {
      await runPositionMap(bot, chatId, subscribed);
      return;
    }

    const pending = pendingByChat.get(chatId);
    if (pending) {
      pendingByChat.delete(chatId);
      if (pending.action === 'batt_trend' && !isClient) return runBatteryTrend(bot, chatId, subscribed, text);
      if (pending.action === 'gps') return runGpsLookup(bot, chatId, subscribed, text);
    }

    await sendWithButtons(bot, chatId, welcome, subscribed);
  }

  async function handleCallbackQuery(bot, query) {
    const chatId = String(query.message.chat.id);
    const data = query.data;
    const subscribed = subStore.isOptedIn(chatId);

    await bot.answerCallbackQuery(query.id);
    pendingByChat.delete(chatId);

    if (data === 'latest_count') {
      await sendLatestCount(bot, chatId, subscribed);
    } else if (data === 'menu') {
      await sendWithButtons(bot, chatId, '📋 <b>Full menu</b>', subscribed, { full: true });
    } else if (data === 'hist_latest') {
      await sendLatestRawDiscovery(bot, chatId, subscribed);
    } else if (data === 'hist_4h') {
      await sendRawDiscoveryData(bot, chatId, subscribed, 4, 'last 4 hours');
    } else if (data === 'hist_24h') {
      await sendRawDiscoveryData(bot, chatId, subscribed, 24, 'last 24 hours');
    } else if (data === 'hist_1d') {
      await sendDailySummaries(bot, chatId, subscribed, { fromDate: new Date(jhbMidnightMsDaysAgo(0)) }, 'last day');
    } else if (data === 'hist_3d') {
      await sendDailySummaries(bot, chatId, subscribed, { fromDate: new Date(jhbMidnightMsDaysAgo(2)) }, 'last 3 days');
    } else if (data === 'hist_7d') {
      await sendDailySummaries(bot, chatId, subscribed, { fromDate: new Date(jhbMidnightMsDaysAgo(6)) }, 'last 7 days');
    } else if (data === 'missing_tags') {
      await runMissingTags(bot, chatId, subscribed);
    } else if (data === 'gps_prompt') {
      pendingByChat.set(chatId, { action: 'gps' });
      await sendMessage(bot, chatId, '📍 Send the tag ID you want the last GPS location for (e.g. <code>3E1E</code>). Or use <code>/gps 3E1E</code>.');
    } else if (data === 'position_map') {
      await runPositionMap(bot, chatId, subscribed);
    } else if (data === 'heatmap_default') {
      await runHeatmap(bot, chatId, subscribed, '');
    } else if (data === 'analytics_batt_chart') {
      const sessions = await fetchHistorySessions(unitIds, {});
      await sendBatteryChart(bot, chatId, buildTagSeries(sessions), subscribed, level);
    } else if (data === 'analytics_batt_list') {
      const sessions = await fetchHistorySessions(unitIds, {});
      await sendWithButtons(bot, chatId, formatBatteryStatusList(buildTagSeries(sessions)), subscribed);
    } else if (data === 'batt_trend_prompt' && !isClient) {
      pendingByChat.set(chatId, { action: 'batt_trend' });
      await sendMessage(bot, chatId, `📉 Send one or more tag IDs (space/comma separated) for a ${BATTERY_TREND_DAYS}-day trend, or <code>*</code> for all tags. E.g. <code>3E1E 441F</code> or <code>*</code>. You can also use <code>/battery 3E1E 441F</code> / <code>/battery *</code>.`);
    } else if (data === 'optin') {
      subStore.optIn(chatId);
      await sendWithButtons(bot, chatId, '✅ You are now subscribed to live tag discovery updates.', true);
    } else if (data === 'optout') {
      subStore.optOut(chatId);
      await sendWithButtons(bot, chatId, '❌ You have unsubscribed from live updates.', false);
    }
  }

  async function sendLatestCount(bot, chatId, subscribed) {
    const allSessions = await fetchHistorySessions(unitIds, { hoursBack: appConfig.liveWindowHours });
    const latest = allSessions.at(-1);
    if (!latest) {
      await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the last ${appConfig.liveWindowHours} hours.`, subscribed);
      return;
    }
    await sendWithButtons(bot, chatId, formatLatestCount(latest), subscribed);
  }

  async function sendLatestRawDiscovery(bot, chatId, subscribed) {
    const allSessions = await fetchHistorySessions(unitIds, { hoursBack: appConfig.liveWindowHours });
    const latest = allSessions.at(-1);
    if (!latest) {
      await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the last ${appConfig.liveWindowHours} hours.`, subscribed);
      return;
    }
    const missingSuffix = formatMissingTagsInline(findMissingTags(allSessions, new Date()));
    await sendWithButtons(bot, chatId, formatSessionMessage(latest, level) + missingSuffix, subscribed);
  }

  async function sendRawDiscoveryData(bot, chatId, subscribed, hoursBack, label) {
    const allSessions = await fetchHistorySessions(unitIds, { hoursBack: Math.max(hoursBack, appConfig.liveWindowHours) });
    const now = new Date();
    const cutoffMs = now.getTime() - hoursBack * 60 * 60 * 1000;
    const displaySessions = allSessions.filter((s) => new Date(s.timestamp).getTime() >= cutoffMs);

    if (displaySessions.length === 0) {
      await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the ${label}.`, subscribed);
      return;
    }

    const missingSuffix = formatMissingTagsInline(findMissingTags(allSessions, now));
    for (let i = 0; i < displaySessions.length - 1; i++) {
      await sendMessage(bot, chatId, formatSessionMessage(displaySessions[i], level));
    }
    const lastText = formatSessionMessage(displaySessions[displaySessions.length - 1], level) + missingSuffix;
    await sendWithButtons(bot, chatId, lastText, subscribed);
  }

  async function sendDailySummaries(bot, chatId, subscribed, range, label) {
    const sessions = await fetchHistorySessions(unitIds, range);
    if (sessions.length === 0) {
      await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the ${label}.`, subscribed);
      return;
    }
    const { byDate, dateOrder } = groupSessionsByDate(sessions);
    for (let i = 0; i < dateOrder.length - 1; i++) {
      await sendMessage(bot, chatId, formatDailySummary(dateOrder[i], byDate[dateOrder[i]], level));
    }
    const lastDate = dateOrder[dateOrder.length - 1];
    await sendWithButtons(bot, chatId, formatDailySummary(lastDate, byDate[lastDate], level), subscribed);
  }

  async function runMissingTags(bot, chatId, subscribed) {
    const sessions = await fetchHistorySessions(unitIds, { hoursBack: MISSING_TAGS_WINDOW_HOURS });
    const missing = findMissingTags(sessions, new Date(), { windowHours: MISSING_TAGS_WINDOW_HOURS });
    await sendWithButtons(bot, chatId, formatMissingTags(missing, { windowHours: MISSING_TAGS_WINDOW_HOURS }), subscribed);
  }

  async function runPositionMap(bot, chatId, subscribed) {
    // Pull the whole live-tracking window so a tag last seen 2 days ago (orange) still
    // appears; anything older than that is unlikely to reflect reality anyway.
    const sessions = await fetchHistorySessions(unitIds, { hoursBack: appConfig.liveWindowHours });
    await sendPositionMap(bot, chatId, subscribed, sessions, level);
  }

  async function runHeatmap(bot, chatId, subscribed, rawInput) {
    const parsed = parseHeatmapArgs(rawInput);
    if (parsed.error) {
      await sendWithButtons(bot, chatId, `⚠️ ${parsed.error}`, subscribed);
      return;
    }
    // Fetch the exact window the user asked for; history.js clamps to HISTORY_START.
    const from = new Date(parsed.fromMs);
    const sessions = await fetchHistorySessions(unitIds, { fromDate: from });
    await sendHeatmap(bot, chatId, subscribed, sessions, {
      fromMs: parsed.fromMs, toMs: parsed.toMs, label: parsed.label, level,
    });
  }

  async function runBatteryTrend(bot, chatId, subscribed, rawInput) {
    const trimmed = String(rawInput || '').trim();
    const sessions = await fetchHistorySessions(unitIds, { hoursBack: BATTERY_TREND_DAYS * 24 });
    const series = buildTagSeries(sessions);

    let ids;
    if (trimmed === '*') {
      // Wildcard: every tag with battery data in the last 7 days. Sorted so the
      // legend order is stable across renders and matches what /battery reports.
      ids = Object.keys(series).sort();
      if (ids.length === 0) {
        await sendWithButtons(bot, chatId, `⚠️ No battery data for any tag in the last ${BATTERY_TREND_DAYS} days.`, subscribed);
        return;
      }
    } else {
      const parsed = parseTagIdList(trimmed);
      if (parsed.invalid.length > 0) {
        await sendMessage(bot, chatId, `⚠️ Ignoring invalid tag ID${parsed.invalid.length > 1 ? 's' : ''}: <code>${parsed.invalid.map((s) => s.replace(/</g, '&lt;')).join(', ')}</code> (must be 1-4 printable-ASCII chars, no spaces).`);
      }
      if (parsed.ids.length === 0) {
        await sendWithButtons(bot, chatId, '⚠️ No valid tag IDs given. Send tag IDs, e.g. <code>3E1E 441F</code>, or <code>*</code> for all.', subscribed);
        return;
      }
      ids = parsed.ids;
    }

    await sendBatteryTrendChart(bot, chatId, series, subscribed, ids, { windowDays: BATTERY_TREND_DAYS, level });
  }

  async function runGpsLookup(bot, chatId, subscribed, rawInput) {
    const { ids, invalid } = parseTagIdList(rawInput);
    if (ids.length === 0) {
      const hint = invalid.length > 0
        ? `⚠️ <code>${invalid[0].replace(/</g, '&lt;')}</code> isn't a valid tag ID (must be 1-4 printable-ASCII chars, no spaces).`
        : '⚠️ Send a tag ID, e.g. <code>3E1E</code>.';
      await sendWithButtons(bot, chatId, hint, subscribed);
      return;
    }
    const tagId = ids[0];
    const sessions = await fetchHistorySessions(unitIds, {});
    const gps = findLatestGpsForTag(sessions, tagId);
    const seen = findTagLastSeen(sessions, tagId);
    await sendWithButtons(bot, chatId, formatTagGps(tagId, gps, seen), subscribed);
  }

  // One poll cycle: fetch each unit's logs since last processed, merge, push any new
  // sessions to this bot's subscribers using this bot's level. No-ops if the runtime
  // isn't currently started (activeBot is null) — e.g. a poll firing mid-restart.
  async function pollOnce() {
    const bot = activeBot;
    if (!bot) return;

    const now = new Date();
    const fromOverride = state.lastProcessedTimestamp
      ? new Date(new Date(state.lastProcessedTimestamp).getTime() - FETCH_BUFFER_MINUTES * 60 * 1000)
      : undefined;

    const sessions = (await fetchAllSessions(now, fromOverride))
      .filter((s) => !state.lastProcessedTimestamp || s.timestamp > state.lastProcessedTimestamp)
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    for (const session of sessions) {
      try {
        const recipients = subStore.getRecipients();
        if (session.discarded) {
          console.log(`[${id}] Session ${session.timestamp}: LOG TIMEOUT on ${session.timeoutUnitIds.join(', ')} — discarding and alerting.`);
          const text = formatTimeoutAlert(session, level);
          for (const chatId of recipients) await sendMessage(bot, chatId, text);
        } else if (session.total > 0) {
          console.log(`[${id}] Session ${session.timestamp}: ${session.total} unique tag(s) across ${session.involvedUnitIds.join(', ')}.`);
          const text = formatLatestCount(session);
          for (const chatId of recipients) await sendWithButtons(bot, chatId, text, subStore.isOptedIn(chatId), { full: true });
        }
        state.lastProcessedTimestamp = session.timestamp;
        stateStore.save(state);
      } catch (err) {
        console.error(`[${id}] Failed to send session ${session.timestamp}:`, err.message);
        break; // retry this and later sessions on the next poll
      }
    }
  }

  // Fetches + merges across this bot's units, with the same buffered-refetch window
  // pollOnce needs. Discarded (timeout) sessions are kept here so live push can alert.
  async function fetchAllSessions(now, fromOverride) {
    const blocksByUnit = {};
    for (const unitId of unitIds) {
      try {
        const text = await fetchUnitLogText(unitId, now, fromOverride);
        blocksByUnit[unitId] = parseLogText(text, unitId);
      } catch (err) {
        console.error(`[${id}] Failed to fetch/parse logs for unit ${unitId}:`, err.message);
        blocksByUnit[unitId] = [];
      }
    }
    return mergeSessions(blocksByUnit);
  }

  function start() {
    subStore.load();
    state = stateStore.load();
    // A local const, not the outer `activeBot` — event handlers below close over THIS
    // specific instance, so they keep working with the real object even after a later
    // stop() reassigns `activeBot`, instead of racing a shared mutable reference to null.
    const bot = new TelegramBot(token, { polling: true });
    activeBot = bot;
    bot.on('polling_error', (err) => console.error(`[${id}] Telegram polling error:`, err.message));
    bot.on('message', (msg) => handleMessage(bot, msg).catch((err) => console.error(`[${id}] handleMessage error:`, err)));
    bot.on('callback_query', (q) => handleCallbackQuery(bot, q).catch((err) => console.error(`[${id}] handleCallbackQuery error:`, err)));
    console.log(`[${id}] Started (${level}). Units: ${unitIds.join(', ')}.`);
  }

  async function stop() {
    const bot = activeBot;
    if (!bot) return;
    activeBot = null;
    try {
      await bot.stopPolling({ cancel: true });
    } catch (err) {
      console.error(`[${id}] Error stopping polling:`, err.message);
    }
    console.log(`[${id}] Stopped.`);
  }

  return { id, botConfig, start, stop, pollOnce };
}
