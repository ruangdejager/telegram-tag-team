import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { buildInlineKeyboard } from './keyboard.js';
import { fetchHistorySessions } from './history.js';
import { formatSessionMessage } from './formatter.js';
import { groupSessionsByDate, formatDailySummary } from './dailySummary.js';
import { buildTagSeries } from './analytics.js';
import { sendBatteryChart } from './charts.js';
import { isOptedIn, optIn, optOut, loadSubscribers } from './subscribers.js';
import { findMissingTags, formatMissingTags, formatMissingTagsInline } from './missingTags.js';
import { findLatestGpsForTag, findTagLastSeen, formatTagGps } from './tagGps.js';
import { parseTagIdList } from './utils.js';

// Per-chat conversational state: after the user taps 'Filter Battery Chart' or
// 'Query Tag GPS', their next plain text message is treated as input for that
// action. Cleared as soon as we use it (or if they type /start / press any button).
const pendingByChat = new Map(); // chatId -> { action: 'batt_filter' | 'gps' }

export function createBot() {
  loadSubscribers();
  const bot = new TelegramBot(config.telegramBotToken, { polling: true });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));
  bot.on('message', (msg) => handleMessage(bot, msg).catch((err) => console.error('handleMessage error:', err)));
  bot.on('callback_query', (query) => handleCallbackQuery(bot, query).catch((err) => console.error('handleCallbackQuery error:', err)));

  return bot;
}

const WELCOME =
  '🐄 <b>Farmranger Tag Monitor</b>\n\n' +
  'Use the buttons below to query tag discovery history, or opt in to receive live updates whenever new tags are detected.\n\n' +
  'Commands: <code>/battery ID [ID ...]</code>, <code>/gps ID</code>, <code>/missing</code>';

async function handleMessage(bot, message) {
  const chatId = String(message.chat.id);
  const subscribed = isOptedIn(chatId);
  const text = (message.text || '').trim();

  if (text.startsWith('/start')) {
    pendingByChat.delete(chatId);
    await sendWithButtons(bot, chatId, WELCOME, subscribed);
    return;
  }
  if (text.startsWith('/battery')) {
    const args = text.replace(/^\/battery\s*/i, '');
    await runBatteryFilter(bot, chatId, subscribed, args);
    return;
  }
  if (text.startsWith('/gps')) {
    const args = text.replace(/^\/gps\s*/i, '');
    await runGpsLookup(bot, chatId, subscribed, args);
    return;
  }
  if (text.startsWith('/missing')) {
    await runMissingTags(bot, chatId, subscribed);
    return;
  }

  // Reply to an earlier button prompt for input.
  const pending = pendingByChat.get(chatId);
  if (pending) {
    pendingByChat.delete(chatId);
    if (pending.action === 'batt_filter') return runBatteryFilter(bot, chatId, subscribed, text);
    if (pending.action === 'gps') return runGpsLookup(bot, chatId, subscribed, text);
  }

  await sendWithButtons(bot, chatId, WELCOME, subscribed);
}

async function handleCallbackQuery(bot, query) {
  const chatId = String(query.message.chat.id);
  const data = query.data;
  const subscribed = isOptedIn(chatId);

  await bot.answerCallbackQuery(query.id);
  // Any button press cancels a prior text-input prompt.
  pendingByChat.delete(chatId);

  if (data === 'hist_4h') {
    await sendRawDiscoveryData(bot, chatId, subscribed, 4, 'last 4 hours');
  } else if (data === 'hist_24h') {
    await sendRawDiscoveryData(bot, chatId, subscribed, 24, 'last 24 hours');
  } else if (data === 'hist_3d') {
    await sendDailySummaries(bot, chatId, subscribed, { hoursBack: 72 }, 'last 3 days');
  } else if (data === 'hist_7d') {
    await sendDailySummaries(bot, chatId, subscribed, { hoursBack: 168 }, 'last 7 days');
  } else if (data === 'missing_tags') {
    await runMissingTags(bot, chatId, subscribed);
  } else if (data === 'gps_prompt') {
    pendingByChat.set(chatId, { action: 'gps' });
    await sendMessage(bot, chatId, '📍 Send the 4-character tag ID you want the last GPS location for (e.g. <code>3E1E</code>). Or use <code>/gps 3E1E</code>.');
  } else if (data === 'analytics_batt_chart') {
    const sessions = await fetchHistorySessions({});
    await sendBatteryChart(bot, chatId, buildTagSeries(sessions), subscribed);
  } else if (data === 'batt_chart_filter') {
    pendingByChat.set(chatId, { action: 'batt_filter' });
    await sendMessage(bot, chatId, '🔎 Send one or more 4-character tag IDs (space or comma separated) to chart. E.g. <code>3E1E 441F</code>. Or use <code>/battery 3E1E 441F</code>.');
  } else if (data === 'optin') {
    optIn(chatId);
    await sendWithButtons(bot, chatId, '✅ You are now subscribed to live tag discovery updates.', true);
  } else if (data === 'optout') {
    optOut(chatId);
    await sendWithButtons(bot, chatId, '❌ You have unsubscribed from live updates.', false);
  }
}

async function sendRawDiscoveryData(bot, chatId, subscribed, hoursBack, label) {
  // Fetch the full live window so we can detect tags that were seen recently but are
  // now missing — the sessions to display are just those inside `hoursBack`.
  const allSessions = await fetchHistorySessions({ hoursBack: Math.max(hoursBack, config.liveWindowHours) });
  const now = new Date();
  const cutoffMs = now.getTime() - hoursBack * 60 * 60 * 1000;
  const displaySessions = allSessions.filter((s) => new Date(s.timestamp).getTime() >= cutoffMs);

  if (displaySessions.length === 0) {
    await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the ${label}.`, subscribed);
    return;
  }

  const missing = findMissingTags(allSessions, now);
  const missingSuffix = formatMissingTagsInline(missing);

  for (let i = 0; i < displaySessions.length - 1; i++) {
    await sendMessage(bot, chatId, formatSessionMessage(displaySessions[i]));
  }
  const lastText = formatSessionMessage(displaySessions[displaySessions.length - 1]) + missingSuffix;
  await sendWithButtons(bot, chatId, lastText, subscribed);
}

async function sendDailySummaries(bot, chatId, subscribed, range, label) {
  const sessions = await fetchHistorySessions(range);
  if (sessions.length === 0) {
    await sendWithButtons(bot, chatId, `ℹ️ No tag discoveries in the ${label}.`, subscribed);
    return;
  }
  const { byDate, dateOrder } = groupSessionsByDate(sessions);
  for (let i = 0; i < dateOrder.length - 1; i++) {
    await sendMessage(bot, chatId, formatDailySummary(dateOrder[i], byDate[dateOrder[i]]));
  }
  const lastDate = dateOrder[dateOrder.length - 1];
  await sendWithButtons(bot, chatId, formatDailySummary(lastDate, byDate[lastDate]), subscribed);
}

async function runMissingTags(bot, chatId, subscribed) {
  const sessions = await fetchHistorySessions({ hoursBack: config.liveWindowHours });
  const missing = findMissingTags(sessions, new Date());
  await sendWithButtons(bot, chatId, formatMissingTags(missing), subscribed);
}

async function runBatteryFilter(bot, chatId, subscribed, rawInput) {
  const { ids, invalid } = parseTagIdList(rawInput);
  if (invalid.length > 0) {
    await sendMessage(bot, chatId, `⚠️ Ignoring invalid tag ID${invalid.length > 1 ? 's' : ''}: <code>${invalid.map((s) => s.replace(/</g, '&lt;')).join(', ')}</code> (must be 4 printable-ASCII chars).`);
  }
  if (ids.length === 0) {
    await sendWithButtons(bot, chatId, '⚠️ No valid tag IDs given. Send 4-character IDs, e.g. <code>3E1E 441F</code>.', subscribed);
    return;
  }
  const sessions = await fetchHistorySessions({});
  const series = buildTagSeries(sessions);
  await sendBatteryChart(bot, chatId, series, subscribed, { filterIds: ids });
}

async function runGpsLookup(bot, chatId, subscribed, rawInput) {
  const { ids, invalid } = parseTagIdList(rawInput);
  if (ids.length === 0) {
    const hint = invalid.length > 0
      ? `⚠️ <code>${invalid[0].replace(/</g, '&lt;')}</code> isn't a valid tag ID (must be 4 printable-ASCII chars).`
      : '⚠️ Send a 4-character tag ID, e.g. <code>3E1E</code>.';
    await sendWithButtons(bot, chatId, hint, subscribed);
    return;
  }
  const tagId = ids[0]; // one-at-a-time lookup
  const sessions = await fetchHistorySessions({});
  const gps = findLatestGpsForTag(sessions, tagId);
  const seen = findTagLastSeen(sessions, tagId);
  await sendWithButtons(bot, chatId, formatTagGps(tagId, gps, seen), subscribed);
}

export async function sendMessage(bot, chatId, text) {
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', disable_web_page_preview: true });
}

export async function sendWithButtons(bot, chatId, text, subscribed) {
  await bot.sendMessage(chatId, text, {
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    reply_markup: buildInlineKeyboard(subscribed),
  });
}
