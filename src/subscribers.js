import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// Extra opted-in chat IDs, in addition to the fixed admin chat (config.telegramChatId,
// which is always subscribed). Loaded once into memory at startup and persisted to disk
// on every mutation — fine for a single bot process.
let extraSubscribers = [];

export function loadSubscribers() {
  try {
    const raw = fs.readFileSync(config.subscribersFile, 'utf8');
    extraSubscribers = JSON.parse(raw);
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Failed to read subscribers file, starting fresh:', err.message);
    extraSubscribers = [];
  }
  return extraSubscribers;
}

function persist() {
  const dir = path.dirname(config.subscribersFile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(config.subscribersFile, JSON.stringify(extraSubscribers, null, 2));
}

export function isOptedIn(chatId) {
  chatId = String(chatId);
  if (chatId === String(config.telegramChatId)) return true;
  return extraSubscribers.includes(chatId);
}

export function optIn(chatId) {
  chatId = String(chatId);
  if (!extraSubscribers.includes(chatId)) {
    extraSubscribers.push(chatId);
    persist();
  }
}

export function optOut(chatId) {
  chatId = String(chatId);
  extraSubscribers = extraSubscribers.filter((id) => id !== chatId);
  persist();
}

// All chat IDs that should receive live discovery pushes.
export function getRecipients() {
  const seen = new Set();
  const result = [];
  for (const id of [String(config.telegramChatId), ...extraSubscribers]) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
  }
  return result;
}
