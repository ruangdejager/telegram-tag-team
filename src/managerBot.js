import TelegramBot from 'node-telegram-bot-api';
import { appConfig, BOT_LEVELS } from './config.js';

// The manager bot is the owner-only control surface for adding/removing/configuring
// worker bots at runtime. It responds ONLY to appConfig.managerChatId — every other
// chat is ignored outright, so the token being present doesn't grant anyone control.
export function startManagerBot(botManager) {
  if (!appConfig.managerBotToken || !appConfig.managerChatId) {
    console.log('Manager bot not configured (MANAGER_BOT_TOKEN / MANAGER_CHAT_ID unset) — skipping.');
    return null;
  }

  const bot = new TelegramBot(appConfig.managerBotToken, { polling: true });
  const owner = String(appConfig.managerChatId);
  const flows = new Map(); // chatId -> { data } for the guided /addbot flow

  bot.on('polling_error', (err) => console.error('[manager] polling error:', err.message));

  const send = (text) => bot.sendMessage(owner, text, { parse_mode: 'HTML', disable_web_page_preview: true });

  const HELP =
    '🛠 <b>Bot Manager</b>\n\n' +
    '<b>/addbot</b> — guided: add a new bot (id, name, level, admin chat, IMEIs, token)\n' +
    '<b>/listbots</b> — list all bots\n' +
    '<b>/removebot &lt;id&gt;</b> — stop and delete a bot\n' +
    '<b>/addimei &lt;id&gt; &lt;imei&gt;</b>\n' +
    '<b>/removeimei &lt;id&gt; &lt;imei&gt;</b>\n' +
    '<b>/setlevel &lt;id&gt; dev|client</b>\n' +
    '<b>/cancel</b> — abort the current /addbot flow';

  async function handle(message) {
    const chatId = String(message.chat.id);
    if (chatId !== owner) return; // hard owner gate
    const text = (message.text || '').trim();

    // Guided /addbot flow takes priority over free text.
    if (flows.has(chatId) && !text.startsWith('/')) {
      await advanceFlow(chatId, text, message.message_id);
      return;
    }

    if (text === '/cancel') {
      flows.delete(chatId);
      await send('Cancelled.');
      return;
    }
    if (text.startsWith('/start') || text.startsWith('/help')) {
      await send(HELP);
      return;
    }
    if (text.startsWith('/addbot')) {
      flows.set(chatId, { data: {} });
      await send('➕ <b>New bot</b>\n\nStep 1/6 — send a short id (slug), e.g. <code>corbu-dexters</code>:');
      return;
    }
    if (text.startsWith('/listbots')) {
      await cmdList();
      return;
    }
    if (text.startsWith('/removebot')) {
      await cmdRemove(text.replace(/^\/removebot\s*/i, '').trim());
      return;
    }
    if (text.startsWith('/addimei')) {
      await cmdImei(text.replace(/^\/addimei\s*/i, '').trim(), true);
      return;
    }
    if (text.startsWith('/removeimei')) {
      await cmdImei(text.replace(/^\/removeimei\s*/i, '').trim(), false);
      return;
    }
    if (text.startsWith('/setlevel')) {
      await cmdSetLevel(text.replace(/^\/setlevel\s*/i, '').trim());
      return;
    }
    await send(HELP);
  }

  async function advanceFlow(chatId, text, messageId) {
    const flow = flows.get(chatId);
    const d = flow.data;
    try {
      if (d.id === undefined) {
        d.id = text.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!d.id) throw new Error('That id is empty after cleanup — use letters, numbers, hyphens.');
        await send(`Step 2/6 — display name for <b>${d.id}</b> (e.g. <code>Corbu Dexters</code>):`);
      } else if (d.name === undefined) {
        d.name = text;
        await send(`Step 3/6 — level? Reply <code>dev</code> or <code>client</code>:`);
      } else if (d.level === undefined) {
        const level = text.toLowerCase();
        if (!BOT_LEVELS.includes(level)) throw new Error('Level must be dev or client.');
        d.level = level;
        await send('Step 4/6 — admin chat id (the Telegram chat that is always subscribed for this bot):');
      } else if (d.adminChatId === undefined) {
        d.adminChatId = text.trim();
        await send('Step 5/6 — IMEI(s), comma or space separated:');
      } else if (d.unitIds === undefined) {
        d.unitIds = text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
        if (d.unitIds.length === 0) throw new Error('No IMEIs found.');
        await send('Step 6/6 — paste the bot token. ⚠️ This message will be deleted immediately for safety.');
      } else {
        d.token = text.trim();
        // Delete the message that contained the token before doing anything else.
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        flows.delete(chatId);
        const created = await botManager.addBot(d);
        await send(`✅ Added <b>${created.name}</b> (<code>${created.id}</code>, ${created.level}) with ${created.unitIds.length} IMEI(s). It is now live.`);
      }
    } catch (err) {
      await send(`⚠️ ${err.message}\nFix and resend, or /cancel.`);
    }
  }

  async function cmdList() {
    const bots = botManager.list();
    if (bots.length === 0) {
      await send('No bots configured. Use /addbot.');
      return;
    }
    const lines = bots.map((b) =>
      `${b.running ? '🟢' : '🔴'} <b>${b.name}</b> (<code>${b.id}</code>) — ${b.level}\n` +
      `   admin: <code>${b.adminChatId || '—'}</code>\n` +
      `   IMEIs: ${b.unitIds.join(', ')}`);
    await send('📋 <b>Bots</b>\n\n' + lines.join('\n\n'));
  }

  async function cmdRemove(id) {
    if (!id) return send('Usage: /removebot &lt;id&gt;');
    try {
      const removed = await botManager.removeBot(id);
      await send(`🗑 Removed <b>${removed.name}</b> (<code>${removed.id}</code>) and stopped it.`);
    } catch (err) {
      await send(`⚠️ ${err.message}`);
    }
  }

  async function cmdImei(args, adding) {
    const [id, imei] = args.split(/\s+/);
    if (!id || !imei) return send(`Usage: /${adding ? 'addimei' : 'removeimei'} &lt;id&gt; &lt;imei&gt;`);
    try {
      const updated = adding ? await botManager.addImei(id, imei) : await botManager.removeImei(id, imei);
      await send(`✅ <b>${updated.id}</b> now has IMEIs: ${updated.unitIds.join(', ')} (restarted).`);
    } catch (err) {
      await send(`⚠️ ${err.message}`);
    }
  }

  async function cmdSetLevel(args) {
    const [id, level] = args.split(/\s+/);
    if (!id || !level) return send('Usage: /setlevel &lt;id&gt; dev|client');
    try {
      const updated = await botManager.setLevel(id, level.toLowerCase());
      await send(`✅ <b>${updated.id}</b> is now <b>${updated.level}</b> (restarted).`);
    } catch (err) {
      await send(`⚠️ ${err.message}`);
    }
  }

  bot.on('message', (msg) => handle(msg).catch((err) => console.error('[manager] handle error:', err)));
  console.log('Manager bot started (owner-gated).');
  return bot;
}
