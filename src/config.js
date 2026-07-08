import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

export const config = {
  unitIds: required('UNIT_IDS').split(',').map((s) => s.trim()).filter(Boolean),
  telegramBotToken: required('TELEGRAM_BOT_TOKEN'),
  telegramChatId: required('TELEGRAM_CHAT_ID'),
  apiBase: process.env.API_BASE || 'https://api.services.farmrangersa.com/v2/unit/',
  pollIntervalSeconds: parseInt(process.env.POLL_INTERVAL_SECONDS || '60', 10),
  // Discovery timestamps are rounded to the nearest bracket of this many minutes;
  // every block (from any device, even repeats from the same device) that rounds
  // to the same bracket is combined into one session.
  mergeBracketMinutes: parseFloat(process.env.MERGE_BRACKET_MINUTES || '15'),
  stateFile: process.env.STATE_FILE || './data/state.json',
  subscribersFile: process.env.SUBSCRIBERS_FILE || './data/subscribers.json',
  // Hard lower bound on how far back any history query / chart / "all time" view will
  // reach, since device data isn't valid before this date. Change via the HISTORY_START
  // env var (e.g. Railway service variable) — no code change needed.
  historyStart: new Date(process.env.HISTORY_START || '2026-06-20'),
};
