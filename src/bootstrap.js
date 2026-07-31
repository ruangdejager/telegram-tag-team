import fs from 'node:fs';
import path from 'node:path';
import { appConfig, legacyBotFromEnv } from './config.js';
import { loadRegistry, saveRegistry } from './registry.js';

// Moves a legacy flat data file (data/<name>) into the per-bot dir (data/<botId>/<name>)
// if the old one exists and the new one doesn't. One-time; safe to run every boot.
function migrateLegacyFile(botId, name) {
  const oldPath = path.join(appConfig.dataDir, name);
  const newPath = path.join(appConfig.dataDir, botId, name);
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.renameSync(oldPath, newPath);
    console.log(`Migrated ${oldPath} -> ${newPath}`);
  }
}

// If there's no registry yet but the legacy single-tenant env vars are present, seed a
// one-bot registry from them and migrate its old flat state/subscriber files. This keeps
// an existing deployment working with zero manual steps. Returns the seeded bot id, or null.
export function seedAndMigrate() {
  const registry = loadRegistry();
  if (registry.bots.length > 0) return null;
  const legacy = legacyBotFromEnv();
  if (!legacy) return null;
  saveRegistry({ bots: [legacy] });
  migrateLegacyFile(legacy.id, 'state.json');
  migrateLegacyFile(legacy.id, 'subscribers.json');
  console.log(`Seeded registry from legacy env as bot "${legacy.id}" (${legacy.level}).`);
  return legacy.id;
}
