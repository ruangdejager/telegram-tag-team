import 'dotenv/config';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Process-global settings shared by every bot in this deployment. Per-bot settings
// (token, IMEIs, level, admin chat) live in the registry (see registry.js), not here.
export const appConfig = {
  apiBase: process.env.API_BASE || 'https://api.services.farmrangersa.com/v2/unit/',
  // Minute past the hour on which to poll (Farmranger uploads at :15, so :20 is safe).
  pollMinute: parseInt(process.env.POLL_MINUTE || '20', 10),
  // Sliding window of history to keep in RAM for missing-tag detection etc.
  liveWindowHours: parseInt(process.env.LIVE_WINDOW_HOURS || '72', 10),
  // A tag is "missing" if seen in the liveWindow but not in the last N hours.
  missingThresholdHours: parseInt(process.env.MISSING_THRESHOLD_HOURS || '8', 10),
  // Discovery timestamps are rounded to the nearest bracket of this many minutes;
  // every block (from any device, even repeats from the same device) that rounds
  // to the same bracket is combined into one session.
  mergeBracketMinutes: parseFloat(process.env.MERGE_BRACKET_MINUTES || '15'),
  // Hard lower bound on how far back any history query / chart reaches, since device
  // data isn't valid before this date. Change via the HISTORY_START env var.
  historyStart: new Date(process.env.HISTORY_START || '2026-06-20'),
  // Base directory for the registry and each bot's per-bot state/subscriber files.
  // On Railway this should point at the mounted volume, e.g. /data.
  dataDir: process.env.DATA_DIR || './data',
  // The manager bot: a separate, owner-gated Telegram bot used to add/remove/list the
  // worker bots at runtime. Optional — if unset, no manager bot is started.
  managerBotToken: process.env.MANAGER_BOT_TOKEN || '',
  managerChatId: process.env.MANAGER_CHAT_ID || '',
};

export const BOT_LEVELS = ['dev', 'client'];

// Normalizes/validates a raw registry entry into a BotConfig. Throws on anything
// structurally invalid so a bad registry surfaces loudly instead of half-starting.
export function normalizeBotConfig(raw) {
  const id = String(raw.id || '').trim();
  const token = String(raw.token || '').trim();
  const name = String(raw.name || id).trim();
  const level = String(raw.level || 'dev').trim().toLowerCase();
  const adminChatId = raw.adminChatId != null ? String(raw.adminChatId).trim() : '';
  const unitIds = (Array.isArray(raw.unitIds) ? raw.unitIds : String(raw.unitIds || '').split(','))
    .map((s) => String(s).trim())
    .filter(Boolean);

  if (!id) throw new Error('Bot config missing id');
  if (!token) throw new Error(`Bot "${id}" missing token`);
  if (!BOT_LEVELS.includes(level)) throw new Error(`Bot "${id}" has invalid level "${level}" (expected dev|client)`);
  if (unitIds.length === 0) throw new Error(`Bot "${id}" has no unitIds`);

  return { id, name, token, level, adminChatId, unitIds };
}

// Builds a one-bot registry seed from the legacy single-tenant env vars, so an
// existing deployment keeps working with no registry file. Returns null if the
// legacy vars aren't present.
export function legacyBotFromEnv() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const unitIds = process.env.UNIT_IDS;
  if (!token || !unitIds) return null;
  return normalizeBotConfig({
    id: process.env.LEGACY_BOT_ID || 'primary',
    name: process.env.LEGACY_BOT_NAME || 'Tag Monitor',
    token,
    level: process.env.LEGACY_BOT_LEVEL || 'dev',
    adminChatId: process.env.TELEGRAM_CHAT_ID || '',
    unitIds,
  });
}
