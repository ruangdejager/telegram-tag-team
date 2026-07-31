import fs from 'node:fs';
import path from 'node:path';
import { appConfig, normalizeBotConfig } from './config.js';

// The registry is the source of truth for which bots exist. It lives on the persistent
// volume (appConfig.dataDir/registry.json) so the manager bot's changes survive
// restarts and redeploys. Shape: { bots: [BotConfig] }.
const registryFile = () => path.join(appConfig.dataDir, 'registry.json');

export function loadRegistry() {
  try {
    const raw = JSON.parse(fs.readFileSync(registryFile(), 'utf8'));
    const bots = (raw.bots || []).map(normalizeBotConfig);
    return { bots };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to read registry, starting empty:', err.message);
    return { bots: [] };
  }
}

export function saveRegistry(registry) {
  const file = registryFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Re-normalize on save so a bad entry never reaches disk.
  const bots = registry.bots.map(normalizeBotConfig);
  fs.writeFileSync(file, JSON.stringify({ bots }, null, 2));
  return { bots };
}

function findIndex(registry, id) {
  return registry.bots.findIndex((b) => b.id === id);
}

// Adds a new bot; throws if the id or token is already in use (a duplicate token
// would make two bots fight over the same getUpdates and 409).
export function addBot(registry, rawBotConfig) {
  const bot = normalizeBotConfig(rawBotConfig);
  if (findIndex(registry, bot.id) !== -1) throw new Error(`A bot with id "${bot.id}" already exists`);
  if (registry.bots.some((b) => b.token === bot.token)) throw new Error('That bot token is already in use');
  registry.bots.push(bot);
  return bot;
}

export function removeBot(registry, id) {
  const idx = findIndex(registry, id);
  if (idx === -1) throw new Error(`No bot with id "${id}"`);
  return registry.bots.splice(idx, 1)[0];
}

export function getBot(registry, id) {
  const bot = registry.bots.find((b) => b.id === id);
  if (!bot) throw new Error(`No bot with id "${id}"`);
  return bot;
}

export function updateBot(registry, id, patch) {
  const idx = findIndex(registry, id);
  if (idx === -1) throw new Error(`No bot with id "${id}"`);
  const updated = normalizeBotConfig({ ...registry.bots[idx], ...patch });
  registry.bots[idx] = updated;
  return updated;
}

export function addImei(registry, id, imei) {
  const bot = getBot(registry, id);
  imei = String(imei).trim();
  if (!imei) throw new Error('Empty IMEI');
  if (bot.unitIds.includes(imei)) throw new Error(`Bot "${id}" already has IMEI ${imei}`);
  return updateBot(registry, id, { unitIds: [...bot.unitIds, imei] });
}

export function removeImei(registry, id, imei) {
  const bot = getBot(registry, id);
  imei = String(imei).trim();
  if (!bot.unitIds.includes(imei)) throw new Error(`Bot "${id}" has no IMEI ${imei}`);
  if (bot.unitIds.length === 1) throw new Error(`Bot "${id}" must keep at least one IMEI`);
  return updateBot(registry, id, { unitIds: bot.unitIds.filter((u) => u !== imei) });
}
