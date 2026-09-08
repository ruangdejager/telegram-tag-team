import 'dotenv/config';

// Process-global settings shared by every bot in this deployment. Per-bot settings
// (Telegram token, org access token, level, admin chat) live in the registry (see
// registry.js), not here.
export const appConfig = {
  // The tagexplore-web app's base URL (no trailing slash), e.g.
  // https://tagexplore.up.railway.app. Every bit of data the bot shows is read
  // from here — the bot never touches the Farmranger logs itself.
  webApiBase: (process.env.WEB_API_BASE || '').replace(/\/$/, ''),
  // Shared secret matching the web app's BOT_PROVISION_TOKEN. Only the manager bot
  // uses it, to attach a new bot to an org and set its dev/client level.
  webProvisionToken: process.env.WEB_PROVISION_TOKEN || '',
  // Minute past the hour on which to poll the web app for new discoveries.
  pollMinute: parseInt(process.env.POLL_MINUTE || '20', 10),
  // Sliding window of history to keep in RAM for missing-tag detection etc.
  liveWindowHours: parseInt(process.env.LIVE_WINDOW_HOURS || '72', 10),
  // A tag is "missing" if seen in the liveWindow but not in the last N hours.
  missingThresholdHours: parseInt(process.env.MISSING_THRESHOLD_HOURS || '8', 10),
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
  // Mapbox public token, used for satellite basemaps (position map + density heatmap).
  // Get one at https://account.mapbox.com/access-tokens. Optional — if unset, the map
  // features respond with a friendly "not configured" message instead of crashing.
  mapboxToken: process.env.MAPBOX_TOKEN || '',
};

export const BOT_LEVELS = ['dev', 'client'];

// Normalizes/validates a raw registry entry into a BotConfig. Throws on anything
// structurally invalid so a bad registry surfaces loudly instead of half-starting.
//
// A bot is now just a Telegram front end bound to one org access token: the token
// (minted by the web app) decides which org it reads and, authoritatively, its
// level. `level` is cached here only so /listbots can show it without a round trip;
// the runtime re-reads the real level from the web app's /context on every poll.
export function normalizeBotConfig(raw) {
  const id = String(raw.id || '').trim();
  const token = String(raw.token || '').trim();
  const name = String(raw.name || id).trim();
  const level = String(raw.level || 'client').trim().toLowerCase();
  const adminChatId = raw.adminChatId != null ? String(raw.adminChatId).trim() : '';
  const apiToken = String(raw.apiToken || '').trim();

  if (!id) throw new Error('Bot config missing id');
  if (!token) throw new Error(`Bot "${id}" missing token`);
  if (!apiToken) throw new Error(`Bot "${id}" missing apiToken (org access token)`);
  if (!BOT_LEVELS.includes(level)) throw new Error(`Bot "${id}" has invalid level "${level}" (expected dev|client)`);

  return { id, name, token, level, adminChatId, apiToken };
}
