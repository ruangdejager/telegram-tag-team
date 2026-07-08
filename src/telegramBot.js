import TelegramBot from 'node-telegram-bot-api';
import { config } from './config.js';
import { buildInlineKeyboard } from './keyboard.js';
import { fetchHistorySessions } from './history.js';
import { formatSessionMessage } from './formatter.js';
import { groupSessionsByDate, formatDailySummary } from './dailySummary.js';
import { buildTagSeries } from './analytics.js';
import { sendBatteryChart } from './charts.js';
import { isOptedIn, optIn, optOut, loadSubscribers } from './subscribers.js';

export function createBot() {
  loadSubscribers();
  const bot = new TelegramBot(config.telegramBotToken, { polling: true });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));
  bot.on('message', (msg) => handleMessage(bot, msg).catch((err) => console.error('handleMessage error:', err)));
  bot.on('callback_query', (query) => handleCallbackQuery(bot, query).catch((err) => console.error('handleCallbackQuery error:', err)));

  return bot;
}

async function handleMessage(bot, message) {
  const chatId = String(message.chat.id);
  const subscribed = isOptedIn(chatId);
  const welcome =
    '🐄 <b>Farmranger Tag Monitor</b>\n\n' +
    'Use the buttons below to query tag discovery history, or opt in to receive live updates whenever new tags are detected.';
  await sendWithButtons(bot, chatId, welcome, subscribed);
}

async function handleCallbackQuery(bot, query) {
  const chatId = String(query.message.chat.id);
  const data = query.data;
  const subscribed = isOptedIn(chatId);

  await bot.answerCallbackQuery(query.id);

  if (data === 'hist_24h') {
    const sessions = await fetchHistorySessions({ hoursBack: 24 });
    if (sessions.length === 0) {
      await sendWithButtons(bot, chatId, 'ℹ️ No tag discoveries in the last 24 hours.', subscribed);
    } else {
      for (let i = 0; i < sessions.length - 1; i++) {
        await sendMessage(bot, chatId, formatSessionMessage(sessions[i]));
      }
      await sendWithButtons(bot, chatId, formatSessionMessage(sessions[sessions.length - 1]), subscribed);
    }
  } else if (data === 'hist_3d') {
    await sendDailySummaries(bot, chatId, subscribed, { hoursBack: 72 }, 'last 3 days');
  } else if (data === 'hist_7d') {
    await sendDailySummaries(bot, chatId, subscribed, { hoursBack: 168 }, 'last 7 days');
  } else if (data === 'hist_all') {
    await sendDailySummaries(bot, chatId, subscribed, {}, 'all time');
  } else if (data === 'analytics_batt_chart') {
    const sessions = await fetchHistorySessions({});
    await sendBatteryChart(bot, chatId, buildTagSeries(sessions), subscribed);
  } else if (data === 'optin') {
    optIn(chatId);
    await sendWithButtons(bot, chatId, '✅ You are now subscribed to live tag discovery updates.', true);
  } else if (data === 'optout') {
    optOut(chatId);
    await sendWithButtons(bot, chatId, '❌ You have unsubscribed from live updates.', false);
  }
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

export async function sendMessage(bot, chatId, text) {
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML' });
}

export async function sendWithButtons(bot, chatId, text, subscribed) {
  await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: buildInlineKeyboard(subscribed) });
}
