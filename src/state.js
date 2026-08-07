import fs from 'node:fs';
import path from 'node:path';
import { appConfig } from './config.js';

const DEFAULT_STATE = { lastProcessedTimestamp: null, sentTimestamps: [] };

// Per-bot state store. Each bot tracks its own lastProcessedTimestamp so two bots
// pointing at the same IMEIs still push independently.
export function createStateStore(botId) {
  const file = path.join(appConfig.dataDir, botId, 'state.json');

  function load() {
    try {
      return { ...DEFAULT_STATE, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[${botId}] Failed to read state file, starting fresh:`, err.message);
      return { ...DEFAULT_STATE };
    }
  }

  function save(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  }

  return { file, load, save };
}
