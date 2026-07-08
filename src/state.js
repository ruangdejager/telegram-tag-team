import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

const DEFAULT_STATE = { lastProcessedTimestamp: null };

export function loadState() {
  try {
    const raw = fs.readFileSync(config.stateFile, 'utf8');
    return { ...DEFAULT_STATE, ...JSON.parse(raw) };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to read state file, starting fresh:', err.message);
    return { ...DEFAULT_STATE };
  }
}

export function saveState(state) {
  const dir = path.dirname(config.stateFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}
