import fs from 'node:fs';
import path from 'node:path';
import { appConfig } from './config.js';

// pendingBrackets: { [sessionTimestampISO]: { sig, stableSince } } — a bracket seen
// but not yet announced, waiting for its content to stop changing (see the settle
// window in botRuntime.js). Persisted so a redeploy mid-settle doesn't restart the
// clock on a round that's already partway there.
//
// A fresh object literal per call, not a shared module-level constant: `pendingBrackets`
// (and `sentTimestamps`) are mutated in place by callers, so every createStateStore()
// needs its own copy rather than all bots that hit the ENOENT/parse-failure path
// sharing (and corrupting) one default.
function defaultState() {
  return { lastProcessedTimestamp: null, sentTimestamps: [], pendingBrackets: {} };
}

// Per-bot state store. Each bot tracks its own lastProcessedTimestamp so two bots
// pointing at the same IMEIs still push independently.
export function createStateStore(botId) {
  const file = path.join(appConfig.dataDir, botId, 'state.json');

  function load() {
    try {
      return { ...defaultState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[${botId}] Failed to read state file, starting fresh:`, err.message);
      return defaultState();
    }
  }

  function save(state) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2));
  }

  return { file, load, save };
}
