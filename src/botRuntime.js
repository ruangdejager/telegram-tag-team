import TelegramBot from 'node-telegram-bot-api';
import { appConfig, BOT_LEVELS } from './config.js';
import { buildSimpleKeyboard, buildFullKeyboard } from './keyboard.js';
import { fetchHistorySessions } from './history.js';
import { formatSessionMessage, formatTimeoutAlert, formatLatestCount, formatBatteryStatusList, formatCountWindow } from './formatter.js';
import { groupSessionsByDate, formatDailySummaryMessages } from './dailySummary.js';
import { buildTagSeries } from './analytics.js';
import { sendBatteryChart, sendBatteryTrendChart } from './charts.js';
import { sendPositionMap, sendHeatmap } from './maps.js';
import { createSubscriberStore } from './subscribers.js';
import { createStateStore } from './state.js';
import { findMissingTags, findTagsMissingFromLatest, formatMissingTags, formatMissingTagsInline } from './missingTags.js';
import { findLatestGpsForTag, findTagLastSeen, formatTagGps } from './tagGps.js';
import { parseTagIdList, jhbMidnightMsDaysAgo } from './utils.js';
import { createWebClient, buildSessionsFromReadings } from './webClient.js';

const BATTERY_TREND_DAYS = 7;
// Heatmap is a fixed 3-day window. Any tag without a GPS fix in that window is
// automatically excluded because we only feed it sessions from the last 3 days —
// there's no separate "last-seen" filter beyond that. Kept as a constant (not
// user-configurable via /heatmap args any more) so the density colorscale, which
// is calibrated for a ~3-day view, stays meaningful.
const HEATMAP_DAYS = 3;
const RECENT_TAGS_WINDOW_HOURS = 7 * 24; // shared "recently active" window: Missing List + both battery lists
// Devices don't always finish uploading a bracket's log by the time a given poll runs
// (e.g. one device is a few polls late). A single "greater than lastProcessedTimestamp"
// watermark is fragile against that: once a *later* bracket gets sent, the watermark
// moves past it, and an earlier bracket that only shows up afterwards is silently
// skipped forever. Re-scanning a wide trailing window every poll and de-duping against
// a set of already-sent bracket timestamps (instead of a single watermark) means a
// late-arriving bracket still gets caught on a later poll as long as it's within this
// window when it finally appears.
const POLL_LOOKBACK_HOURS = 4;

// One running bot: owns its Telegram connection, per-chat prompt state, per-bot
// state + subscriber stores, and level-aware handlers. `botConfig` = { id, name,
// token, level, adminChatId, apiToken }. All of its data comes from the
// tagexplore-web app through the org-scoped web client built from `apiToken` — it
// never reads a Farmranger log itself.
//
// Every handler below takes `bot` as an explicit parameter rather than reading a
// shared mutable variable — event listeners are registered with the *specific*
// TelegramBot instance captured at start() time, so if stop()/restart() swaps or
// clears the runtime's tracked instance while an already-fired event is still being
// handled, that in-flight call keeps using the real (still-usable-for-API-calls)
// instance instead of crashing on a null reference.
export function createBotRuntime(botConfig) {
  // token / id / adminChatId / apiToken are immutable for the lifetime of the runtime
  // — a token or id change would require tearing everything down anyway. name / level
  // are hot-swappable via applyConfig(): we never restart the Telegram polling for a
  // config edit, since a fresh new TelegramBot() on the same token would race with the
  // old poller — Telegram's server keeps the long-poll slot reserved for up to 50s
  // after the client aborts, so a quick restart 409s. The polling loop and handler
  // wiring don't depend on the mutable fields; only the data-fetch + render paths do,
  // and those read from `let` bindings updated below.
  //
  // `level`, `activeTagIds` and `hiddenTagIds` are cached from the last web /context
  // read (throttled to contextRefreshMinutes, see maybeRefreshContext): the web app's
  // token is the real authority on all three, so a level, whitelist or tag-toggle
  // change made there lands without redeploying or reconfiguring the bot.
  const { id, token, adminChatId, apiToken } = botConfig;
  const webClient = createWebClient(apiToken);
  let name = botConfig.name;
  let level = botConfig.level;
  let isClient = level === 'client';
  let orgName = '';
  // Whitelisted tags, split by org_tags.hidden: active ones count towards the
  // discovery total and its denominator; hidden ones (decommissioned, or never put
  // on an animal) are dropped from every count but still tallied as "(+N)" if one
  // checks in anyway. Both empty means no whitelist is configured at all.
  let activeTagIds = [];
  let hiddenTagIds = [];
  let lastContextRefreshAt = null; // ms epoch; null until the first successful refresh
  const stateStore = createStateStore(id);
  const subStore = createSubscriberStore(id, adminChatId);
  const pendingByChat = new Map(); // chatId -> { action: 'batt_trend' | 'gps' }

  let activeBot = null; // only used by start()/stop()/pollOnce(), never by event handlers
  let state = { lastProcessedTimestamp: null, sentTimestamps: [], pendingBrackets: {} };

  let welcome = buildWelcome();
  function buildWelcome() {
    return `🐄 <b>${name}</b>\n\n` +
      'Use the buttons below to query tag discovery history, or opt in to receive live updates whenever new tags are detected.\n\n' +
      (isClient
        ? 'Commands: <code>/gps ID</code>, <code>/missing</code>, <code>/count Nh</code>'
        : `Commands: <code>/battery ID [ID ...]</code> or <code>/battery *</code> (${BATTERY_TREND_DAYS}d trend, per tag or all), <code>/gps ID</code>, <code>/missing</code>, <code>/count Nh</code>, <code>/heatmap</code> (last ${HEATMAP_DAYS}d)`);
  }

  // Applies a live config change (level / display name) without touching the
  // TelegramBot polling connection — the only fields any handler actually reads via
  // closure are the mutable bindings above, so updating them in place is enough.
  // Refuses to run if id/token/adminChatId/apiToken are being changed, since those
  // really would require a fresh runtime.
  function applyConfig(newBotConfig) {
    if (newBotConfig.id !== id) throw new Error(`applyConfig: id mismatch (${id} vs ${newBotConfig.id})`);
    if (newBotConfig.token !== token) throw new Error(`applyConfig: token change requires restart`);
    if ((newBotConfig.adminChatId || '') !== (adminChatId || '')) throw new Error('applyConfig: adminChatId change requires restart');
    if ((newBotConfig.apiToken || '') !== (apiToken || '')) throw new Error('applyConfig: apiToken change requires restart');
    name = newBotConfig.name;
    level = newBotConfig.level;
    isClient = level === 'client';
    welcome = buildWelcome();
    console.log(`[${id}] Config updated in place (${level}).`);
  }

  // Pulls this bot's authoritative org/level/whitelist from the web app. Called at
  // start and (throttled) on the poll cycle, so a change made in the web admin
  // (level, whitelist, a tag's hidden flag, org rename) reaches the bot without a
  // redeploy. Best-effort: on failure the last known values stay in place rather
  // than blanking the bot out.
  async function refreshContext() {
    const ctx = await webClient.fetchContext();
    orgName = ctx.orgName || '';
    const tags = ctx.tags || [];
    const upperTagId = (t) => String(t.tagId || '').toUpperCase();
    activeTagIds = tags.filter((t) => !t.hidden).map(upperTagId).filter(Boolean);
    hiddenTagIds = tags.filter((t) => t.hidden).map(upperTagId).filter(Boolean);
    const newLevel = String(ctx.level || level).toLowerCase();
    if (newLevel !== level && BOT_LEVELS.includes(newLevel)) {
      level = newLevel;
      isClient = level === 'client';
      welcome = buildWelcome();
    }
  }

  // Gates refreshContext() to once per contextRefreshMinutes — at a 60s poll cycle,
  // refreshing on every tick would be a wasted request almost every time. Always
  // refreshes on the very first call (lastContextRefreshAt is still null then), so a
  // freshly started bot doesn't wait out the full interval before its first read.
  // Best-effort like refreshContext itself: a failed refresh leaves the last known
  // values in place and is retried on the next poll rather than waiting out the
  // interval again.
  async function maybeRefreshContext() {
    const nowMs = Date.now();
    if (lastContextRefreshAt !== null && nowMs - lastContextRefreshAt < appConfig.contextRefreshMinutes * 60 * 1000) return;
    try {
      await refreshContext();
      lastContextRefreshAt = nowMs;
    } catch (err) {
      console.error(`[${id}] Context refresh failed:`, err.message);
    }
  }

  // Applies the tag whitelist to a session list. A tag is either active (kept, counts
  // towards `total`), hidden (whitelisted but org_tags.hidden — decommissioned, or
  // never put on an animal; dropped from `tags`/`total` but tallied in
  // `hiddenSeenIds` since it still checked in), or unknown (not on the whitelist at
  // all; dropped silently, as before). No-op when there's no whitelist configured at
  // all (both lists empty), so bots without one behave exactly as before. Used
  // everywhere EXCEPT the dev-side raw discovery buttons (Latest / Last 4h / Last
  // 24h), which must always surface the true unfiltered reading.
  function applyTagFilter(sessions) {
    if (activeTagIds.length === 0 && hiddenTagIds.length === 0) return sessions;
    const active = new Set(activeTagIds);
    const hidden = new Set(hiddenTagIds);
    return sessions.map((s) => {
      const keptTags = [];
      const hiddenSeenIds = [];
      for (const t of s.tags) {
        if (active.has(t.id)) keptTags.push(t);
        else if (hidden.has(t.id)) hiddenSeenIds.push(t.id);
      }
      if (keptTags.length === s.tags.length && hiddenSeenIds.length === 0) return s;
      return { ...s, tags: keptTags, total: keptTags.length, hiddenSeenIds };
    });
  }

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
    if (text.startsWith('/heatmap') && !isClient) {
      await runHeatmap(bot, chatId, subscribed);
      return;
    }
    if (text.startsWith('/map') && !isClient) {
      await runPositionMap(bot, chatId, subscribed);
      return;
    }
    if (text.startsWith('/count')) {
      await runCountWindow(bot, chatId, subscribed, text.replace(/^\/count\s*/i, ''));
      return;
    }

    const pending = pendingByChat.get(chatId);
    if (pending) {
      pendingByChat.delete(chatId);
      if (pending.action === 'batt_trend' && !isClient) return runBatteryTrend(bot, chatId, subscribed, text);
      if (pending.action === 'gps') return runGpsLookup(bot, chatId, subscribed, text);
      if (pending.action === 'count_window') return runCountWindow(bot, chatId, subscribed, text);
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
    } else if (data === 'count_window_prompt') {
      pendingByChat.set(chatId, { action: 'count_window' });
      await sendMessage(bot, chatId, '🕒 How many hours back should I count? Send a number (e.g. <code>4</code>). Or use <code>/count 4</code>.');
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
    } else if (data === 'position_map' && !isClient) {
      await runPositionMap(bot, chatId, subscribed);
    } else if (data === 'heatmap_default' && !isClient) {
      await runHeatmap(bot, chatId, subscribed);
    } else if (data === 'latest_positions_map' && !isClient) {
      await runLatestPositionMap(bot, chatId, subscribed);
    } else if (data === 'analytics_batt_chart') {
      const sessions = applyTagFilter(await fetchHistorySessions(webClient, { hoursBack: RECENT_TAGS_WINDOW_HOURS }));
      await sendBatteryChart(bot, chatId, buildTagSeries(sessions), subscribed, level);
    } else if (data === 'analytics_batt_list') {
      const sessions = applyTagFilter(await fetchHistorySessions(webClient, { hoursBack: RECENT_TAGS_WINDOW_HOURS }));
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

  // Rolling-window count: unique tag IDs across every discovery in the last N hours,
  // plus the discovery-session count. Whitelist-aware (via applyTagFilter) so the count
  // reflects only tracked tags. Accepts either just a number of hours (`4`, `4h`) or a
  // number of days (`3d`). Rejects zero/negative or unparseable input with a friendly
  // hint so the user can retry without re-prompting.
  const COUNT_WINDOW_MAX_HOURS = 30 * 24; // cap the window at the historyStart's ballpark
  async function runCountWindow(bot, chatId, subscribed, rawInput) {
    const trimmed = String(rawInput || '').trim();
    const match = trimmed.match(/^(\d+)\s*([hd])?$/i);
    if (!match) {
      await sendWithButtons(bot, chatId, '⚠️ Send a positive number of hours (e.g. <code>4</code> or <code>4h</code>), or use days like <code>2d</code>.', subscribed);
      return;
    }
    const n = parseInt(match[1], 10);
    const unit = (match[2] || 'h').toLowerCase();
    const hours = unit === 'd' ? n * 24 : n;
    if (hours <= 0) {
      await sendWithButtons(bot, chatId, '⚠️ Window must be at least 1 hour.', subscribed);
      return;
    }
    if (hours > COUNT_WINDOW_MAX_HOURS) {
      await sendWithButtons(bot, chatId, `⚠️ Window too long (max ${COUNT_WINDOW_MAX_HOURS / 24}d).`, subscribed);
      return;
    }
    const sessions = applyTagFilter(await fetchHistorySessions(webClient, { hoursBack: hours }));
    // fetchHistorySessions already trims to the requested boundary, so every returned
    // session is inside the window. A whitelist may have zeroed out some sessions'
    // totals — those still count as "a discovery happened" but contribute no tag IDs.
    const uniqueIds = new Set();
    const hiddenSeenIds = new Set();
    let sessionCount = 0;
    for (const s of sessions) {
      sessionCount++;
      for (const t of s.tags) uniqueIds.add(t.id);
      for (const tagId of s.hiddenSeenIds || []) hiddenSeenIds.add(tagId);
    }
    await sendWithButtons(
      bot,
      chatId,
      formatCountWindow({
        hours,
        uniqueTagCount: uniqueIds.size,
        sessionCount,
        activeTagTotal: activeTagIds.length,
        hiddenSeenCount: hiddenSeenIds.size,
      }),
      subscribed,
    );
  }

  async function sendLatestCount(bot, chatId, subscribed) {
    const allSessions = applyTagFilter(await fetchHistorySessions(webClient, { hoursBack: appConfig.liveWindowHours }));
    const latest = allSessions.at(-1);
    if (!latest) {
      await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the last ${appConfig.liveWindowHours} hours.`, subscribed);
      return;
    }
    await sendWithButtons(bot, chatId, formatLatestCount(latest, activeTagIds.length), subscribed);
  }

  async function sendLatestRawDiscovery(bot, chatId, subscribed) {
    const allSessions = await fetchHistorySessions(webClient, { hoursBack: appConfig.liveWindowHours });
    const latest = allSessions.at(-1);
    if (!latest) {
      await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the last ${appConfig.liveWindowHours} hours.`, subscribed);
      return;
    }
    const missingSuffix = formatMissingTagsInline(findMissingTags(allSessions, new Date()));
    await sendWithButtons(bot, chatId, formatSessionMessage(latest, level) + missingSuffix, subscribed);
  }

  async function sendRawDiscoveryData(bot, chatId, subscribed, hoursBack, label) {
    const allSessions = await fetchHistorySessions(webClient, { hoursBack: Math.max(hoursBack, appConfig.liveWindowHours) });
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
    const sessions = applyTagFilter(await fetchHistorySessions(webClient, range));
    if (sessions.length === 0) {
      await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the ${label}.`, subscribed);
      return;
    }
    const { byDate, dateOrder } = groupSessionsByDate(sessions);
    // Flattened across dates AND within a date: a single day can itself split into
    // several Telegram-safe messages (see formatDailySummaryMessages), so every
    // message in the whole run gets treated the same way — all but the very last
    // are plain sends, the last one carries the keyboard.
    const messages = dateOrder.flatMap((d) => formatDailySummaryMessages(d, byDate[d], level));
    for (let i = 0; i < messages.length - 1; i++) {
      await sendMessage(bot, chatId, messages[i]);
    }
    await sendWithButtons(bot, chatId, messages[messages.length - 1], subscribed);
  }

  async function runMissingTags(bot, chatId, subscribed) {
    const sessions = applyTagFilter(await fetchHistorySessions(webClient, { hoursBack: RECENT_TAGS_WINDOW_HOURS }));
    const missing = findTagsMissingFromLatest(sessions, new Date(), { windowHours: RECENT_TAGS_WINDOW_HOURS });
    await sendWithButtons(bot, chatId, formatMissingTags(missing, { windowHours: RECENT_TAGS_WINDOW_HOURS, level }), subscribed);
  }

  async function runPositionMap(bot, chatId, subscribed) {
    // Pull the whole live-tracking window so a tag last seen 2 days ago (orange) still
    // appears; anything older than that is unlikely to reflect reality anyway.
    const sessions = applyTagFilter(await fetchHistorySessions(webClient, { hoursBack: appConfig.liveWindowHours }));
    await sendPositionMap(bot, chatId, subscribed, sessions, level);
  }

  // "Where were the tags right now?" — plots only tags that reported lat/lon in the
  // most recent discovery, ignoring older GPS fixes entirely. The Latest button already
  // decides what "latest" is by using the liveWindow, so we reuse that fetch shape.
  async function runLatestPositionMap(bot, chatId, subscribed) {
    const sessions = applyTagFilter(await fetchHistorySessions(webClient, { hoursBack: appConfig.liveWindowHours }));
    await sendPositionMap(bot, chatId, subscribed, sessions, level, { mode: 'latest' });
  }

  async function runHeatmap(bot, chatId, subscribed) {
    // Fixed 3-day window: anything older is dropped implicitly by only fetching the
    // last 3 days, so a tag without a GPS fix in that window contributes no points.
    const toMs = Date.now();
    const fromMs = toMs - HEATMAP_DAYS * 24 * 60 * 60 * 1000;
    const sessions = applyTagFilter(await fetchHistorySessions(webClient, { hoursBack: HEATMAP_DAYS * 24 }));
    await sendHeatmap(bot, chatId, subscribed, sessions, {
      fromMs, toMs, label: `last ${HEATMAP_DAYS}d`, level,
    });
  }

  async function runBatteryTrend(bot, chatId, subscribed, rawInput) {
    const trimmed = String(rawInput || '').trim();
    // Fetch unfiltered so an explicit /battery ID still works for a tag that isn't on
    // the whitelist (explicit lookups are intentional — the user knows what they want).
    // The `*` wildcard applies the whitelist below so "all" means "all tracked."
    const sessions = await fetchHistorySessions(webClient, { hoursBack: BATTERY_TREND_DAYS * 24 });
    const series = buildTagSeries(sessions);

    let ids;
    if (trimmed === '*') {
      // Wildcard: every tag with battery data in the last 7 days. Sorted so the
      // legend order is stable across renders and matches what /battery reports.
      // Whitelist-aware: `*` means "all tracked (and not switched off)" when a
      // whitelist is configured.
      const allow = activeTagIds.length ? new Set(activeTagIds) : null;
      ids = Object.keys(series).filter((id) => !allow || allow.has(id)).sort();
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
    const sessions = await fetchHistorySessions(webClient, {});
    const gps = findLatestGpsForTag(sessions, tagId);
    const seen = findTagLastSeen(sessions, tagId);
    await sendWithButtons(bot, chatId, formatTagGps(tagId, gps, seen), subscribed);
  }

  // A bracket's content signature: changes whenever a new reader's data lands in it
  // (tag count, device count, duration or arrival clock moves). Used by the settle
  // window below to tell "still filling up" from "done" without caring whether the
  // new data came in via a CBOR push or a scrape.
  function sessionSignature(session) {
    return `${session.tags.length}|${session.involvedUnitIds.length}|${session.durationSeconds}|${session.receivedAt ?? 0}`;
  }

  // One poll cycle: fetch readings since the last lookback window, hold each new
  // bracket until its content stops changing, then push it to this bot's
  // subscribers using this bot's level. No-ops if the runtime isn't currently
  // started (activeBot is null) — e.g. a poll firing mid-restart.
  async function pollOnce() {
    const bot = activeBot;
    if (!bot) return;

    // Re-sync org/level/whitelist from the web app, throttled — see
    // maybeRefreshContext. Best-effort — a blip keeps the last known context.
    await maybeRefreshContext();

    const now = new Date();
    const nowMs = now.getTime();
    const cutoffMs = nowMs - POLL_LOOKBACK_HOURS * 60 * 60 * 1000;
    const fromOverride = new Date(cutoffMs);
    const sentTimestamps = new Set(state.sentTimestamps || []);
    // A working copy: mutated as brackets are tracked/settled/sent below, then
    // persisted once at the end of the cycle regardless of how it ends (nothing
    // ready yet, some sent, or a send failure broke out of the loop partway).
    const pendingBrackets = { ...(state.pendingBrackets || {}) };
    // Migration guard: a bot upgraded from the old single-watermark scheme has a
    // lastProcessedTimestamp but an empty sentTimestamps set. Without this, the first
    // poll after the upgrade would treat everything already sent in the lookback window
    // as unsent and re-push it. Once at least one session has been recorded in the new
    // set, this no longer applies and late arrivals are caught purely by set membership.
    const legacyWatermark = sentTimestamps.size === 0 ? state.lastProcessedTimestamp : null;

    const sessions = (await fetchAllSessions(now, fromOverride))
      .filter((s) => !sentTimestamps.has(s.timestamp) && (!legacyWatermark || s.timestamp > legacyWatermark))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

    for (const session of sessions) {
      const sig = sessionSignature(session);
      const pending = pendingBrackets[session.timestamp];
      const alreadyStable = pending && pending.sig === sig;
      const settled = alreadyStable && nowMs - pending.stableSince >= appConfig.settleSeconds * 1000;

      if (!settled) {
        // New sighting, or its content just changed (another reader landed): (re)start
        // the settle clock. Leave an already-stable-but-not-yet-due entry untouched so
        // its stableSince doesn't keep sliding forward.
        pendingBrackets[session.timestamp] = alreadyStable ? pending : { sig, stableSince: nowMs };
        continue;
      }

      try {
        const recipients = subStore.getRecipients();
        if (session.discarded) {
          console.log(`[${id}] Session ${session.timestamp}: LOG TIMEOUT on ${session.timeoutUnitIds.join(', ')} — discarding and alerting.`);
          const text = formatTimeoutAlert(session, level);
          for (const chatId of recipients) await sendMessage(bot, chatId, text);
        } else if (session.total > 0) {
          const [filtered] = applyTagFilter([session]);
          if (filtered.total === 0) {
            // The round happened but no whitelisted tag was in it — mark sent so we
            // don't reconsider it, but push nothing (subscribers only care about
            // discoveries involving their tracked fleet).
            console.log(`[${id}] Session ${session.timestamp}: ${session.total} raw tag(s), 0 after whitelist — skipping push.`);
          } else {
            console.log(`[${id}] Session ${session.timestamp}: ${filtered.total}/${activeTagIds.length} tracked tag(s) across ${session.involvedUnitIds.join(', ')}.`);
            const text = formatLatestCount(filtered, activeTagIds.length);
            for (const chatId of recipients) await sendWithButtons(bot, chatId, text, subStore.isOptedIn(chatId));
          }
        }
        sentTimestamps.add(session.timestamp);
        delete pendingBrackets[session.timestamp];
        state.lastProcessedTimestamp = session.timestamp;
      } catch (err) {
        console.error(`[${id}] Failed to send session ${session.timestamp}:`, err.message);
        // Leave this bracket's pending entry as already-settled (don't touch it) so
        // the very next poll retries it immediately instead of waiting out another
        // full settle window. Also stop here, as before: later sessions in this
        // cycle retry next poll too, preserving send order.
        break;
      }
    }

    // Prune anything the lookback window can no longer re-fetch anyway, so neither
    // map grows unbounded — they only need to cover POLL_LOOKBACK_HOURS. Persisted
    // once here regardless of outcome, so a bracket newly tracked this cycle (but
    // not yet settled) isn't lost if the process restarts before it's due.
    state.sentTimestamps = [...sentTimestamps].filter((ts) => new Date(ts).getTime() >= cutoffMs);
    state.pendingBrackets = Object.fromEntries(
      Object.entries(pendingBrackets).filter(([ts]) => new Date(ts).getTime() >= cutoffMs),
    );
    stateStore.save(state);
  }

  // Rebuilds this bot's sessions over the buffered-refetch window pollOnce needs,
  // straight from the web app's stored readings — no logs, no parsing. The web app
  // only stores successful readings, so there are no discarded (timeout) sessions
  // to surface here any more.
  async function fetchAllSessions(now, fromOverride) {
    try {
      const { readings, rounds } = await webClient.fetchReadings(fromOverride.getTime(), now.getTime());
      return buildSessionsFromReadings(readings, rounds);
    } catch (err) {
      console.error(`[${id}] Failed to fetch readings from web app:`, err.message);
      return [];
    }
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
    // Warm the org/level/whitelist context so on-demand menu queries have it before
    // the first scheduled poll. Fire-and-forget — maybeRefreshContext() will retry
    // on the poll cycle regardless. Tracks lastContextRefreshAt on success so that
    // first poll (which typically fires moments later) doesn't redundantly refetch.
    refreshContext()
      .then(() => { lastContextRefreshAt = Date.now(); })
      .catch((err) => console.error(`[${id}] Initial context load failed:`, err.message));
    console.log(`[${id}] Started (${level}).`);
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

  return { id, botConfig, start, stop, pollOnce, applyConfig };
}
