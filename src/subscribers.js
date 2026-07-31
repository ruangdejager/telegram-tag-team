import fs from 'node:fs';
import path from 'node:path';
import { appConfig } from './config.js';

// Per-bot subscriber store. The admin chat (the bot's own adminChatId) is always
// subscribed; extra chat IDs opt in/out and are persisted to the bot's own file.
export function createSubscriberStore(botId, adminChatId) {
  const file = path.join(appConfig.dataDir, botId, 'subscribers.json');
  const admin = adminChatId ? String(adminChatId) : null;
  let extra = [];

  function load() {
    try {
      extra = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error(`[${botId}] Failed to read subscribers file, starting fresh:`, err.message);
      extra = [];
    }
    return extra;
  }

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(extra, null, 2));
  }

  function isOptedIn(chatId) {
    chatId = String(chatId);
    if (admin && chatId === admin) return true;
    return extra.includes(chatId);
  }

  function optIn(chatId) {
    chatId = String(chatId);
    if (!extra.includes(chatId)) {
      extra.push(chatId);
      persist();
    }
  }

  function optOut(chatId) {
    chatId = String(chatId);
    extra = extra.filter((id) => id !== chatId);
    persist();
  }

  function getRecipients() {
    const seen = new Set();
    const result = [];
    for (const id of [...(admin ? [admin] : []), ...extra]) {
      if (!seen.has(id)) {
        seen.add(id);
        result.push(id);
      }
    }
    return result;
  }

  return { file, load, isOptedIn, optIn, optOut, getRecipients };
}
