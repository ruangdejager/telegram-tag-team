import TelegramBot from 'node-telegram-bot-api';
import { appConfig } from './config.js';
import { buildInlineKeyboard } from './keyboard.js';
import { fetchHistorySessions } from './history.js';
import { formatSessionMessage, formatTimeoutAlert } from './formatter.js';
import { groupSessionsByDate, formatDailySummary } from './dailySummary.js';
import { buildTagSeries } from './analytics.js';
import { sendBatteryChart, sendBatteryTrendChart } from './charts.js';
import { createSubscriberStore } from './subscribers.js';
import { createStateStore } from './state.js';
import { findMissingTags, formatMissingTags, formatMissingTagsInline } from './missingTags.js';
import { findLatestGpsForTag, findTagLastSeen, formatTagGps } from './tagGps.js';
import { parseTagIdList } from './utils.js';
import { fetchUnitLogText } from './apiClient.js';
import { parseLogText } from './logParser.js';
import { mergeSessions } from './sessionMerger.js';

const BATTERY_TREND_DAYS = 7;
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
      ? 'Commands: <code>/gps ID</code>, <code>/missing</code>'
      : `Commands: <code>/battery ID [ID ...]</code> (${BATTERY_TREND_DAYS}d trend), <code>/gps ID</code>, <code>/missing</code>`);

  async function sendMessage(bot, chatId, text) {
    await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
  }

  async function sendWithButtons(bot, chatId, text, subscribed) {
    await bot.sendMessage(chatId, text, {
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: buildInlineKeyboard(subscribed, level),
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

    if (data === 'hist_latest') {
      await sendLatestRawDiscovery(bot, chatId, subscribed);
    } else if (data === 'hist_4h') {
      await sendRawDiscoveryData(bot, chatId, subscribed, 4, 'last 4 hours');
    } else if (data === 'hist_24h') {
      await sendRawDiscoveryData(bot, chatId, subscribed, 24, 'last 24 hours');
    } else if (data === 'hist_1d') {
      await sendDailySummaries(bot, chatId, subscribed, { hoursBack: 24 }, 'last day');
    } else if (data === 'hist_3d') {
      await sendDailySummaries(bot, chatId, subscribed, { hoursBack: 72 }, 'last 3 days');
    } else if (data === 'hist_7d') {
      await sendDailySummaries(bot, chatId, subscribed, { hoursBack: 168 }, 'last 7 days');
    } else if (data === 'missing_tags') {
      await runMissingTags(bot, chatId, subscribed);
    } else if (data === 'gps_prompt') {
      pendingByChat.set(chatId, { action: 'gps' });
      await sendMessage(bot, chatId, '📍 Send the tag ID you want the last GPS location for (e.g. <code>3E1E</code>). Or use <code>/gps 3E1E</code>.');
    } else if (data === 'analytics_batt_chart') {
      const sessions = await fetchHistorySessions(unitIds, {});
      await sendBatteryChart(bot, chatId, buildTagSeries(sessions), subscribed, level);
    } else if (data === 'batt_trend_prompt' && !isClient) {
      pendingByChat.set(chatId, { action: 'batt_trend' });
      await sendMessage(bot, chatId, `📉 Send one or more tag IDs (space/comma separated) for a ${BATTERY_TREND_DAYS}-day trend. E.g. <code>3E1E 441F</code>. Or use <code>/battery 3E1E 441F</code>.`);
    } else if (data === 'optin') {
      subStore.optIn(chatId);
      await sendWithButtons(bot, chatId, '✅ You are now subscribed to live tag discovery updates.', true);
    } else if (data === 'optout') {
      subStore.optOut(chatId);
      await sendWithButtons(bot, chatId, '❌ You have unsubscribed from live updates.', false);
    }
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
    const sessions = await fetchHistorySessions(unitIds, { hoursBack: appConfig.liveWindowHours });
    const missing = findMissingTags(sessions, new Date());
    await sendWithButtons(bot, chatId, formatMissingTags(missing), subscribed);
  }

  async function runBatteryTrend(bot, chatId, subscribed, rawInput) {
    const { ids, invalid } = parseTagIdList(rawInput);
    if (invalid.length > 0) {
      await sendMessage(bot, chatId, `⚠️ Ignoring invalid tag ID${invalid.length > 1 ? 's' : ''}: <code>${invalid.map((s) => s.replace(/</g, '&lt;')).join(', ')}</code> (must be 1-4 printable-ASCII chars, no spaces).`);
    }
    if (ids.length === 0) {
      await sendWithButtons(bot, chatId, '⚠️ No valid tag IDs given. Send tag IDs, e.g. <code>3E1E 441F</code>.', subscribed);
      return;
    }
    const sessions = await fetchHistorySessions(unitIds, { hoursBack: BATTERY_TREND_DAYS * 24 });
    const series = buildTagSeries(sessions);
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
          const text = formatSessionMessage(session, level);
          for (const chatId of recipients) await sendWithButtons(bot, chatId, text, subStore.isOptedIn(chatId));
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
