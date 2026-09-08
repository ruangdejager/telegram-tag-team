import TelegramBot from 'node-telegram-bot-api';
import { appConfig, BOT_LEVELS } from './config.js';
import { createProvisionClient } from './webClient.js';

// The manager bot is the owner-only control surface for attaching/removing worker
// bots at runtime. It responds ONLY to appConfig.managerChatId — every other chat is
// ignored outright, so the token being present doesn't grant anyone control.
//
// It does exactly two things and no more: connect a new Telegram bot to an existing
// tagexplore-web organisation, and set that bot's dev/client level. Everything else
// about an org — its devices/IMEIs, tag whitelist, ingest — is managed in the web app.
export function startManagerBot(botManager) {
  if (!appConfig.managerBotToken || !appConfig.managerChatId) {
    console.log('Manager bot not configured (MANAGER_BOT_TOKEN / MANAGER_CHAT_ID unset) — skipping.');
    return null;
  }

  const bot = new TelegramBot(appConfig.managerBotToken, { polling: true });
  const owner = String(appConfig.managerChatId);
  const provision = createProvisionClient();
  const flows = new Map(); // chatId -> { data } for the guided /addbot flow

  bot.on('polling_error', (err) => console.error('[manager] polling error:', err.message));

  const send = (text) => bot.sendMessage(owner, text, { parse_mode: 'HTML', disable_web_page_preview: true });

  const HELP =
    '🛠 <b>Bot Manager</b>\n\n' +
    '<b>/addbot</b> — guided: connect a new bot to an org (id, name, org, level, token)\n' +
    '<b>/listbots</b> — list all bots\n' +
    '<b>/removebot &lt;id&gt;</b> — stop and delete a bot\n' +
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
      await startAddFlow(chatId);
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
    if (text.startsWith('/setlevel')) {
      await cmdSetLevel(text.replace(/^\/setlevel\s*/i, '').trim());
      return;
    }
    await send(HELP);
  }

  // Fetches the org list from the web app up front, so the flow can only offer orgs
  // that actually exist — the manager never creates an org, it only links to one.
  async function startAddFlow(chatId) {
    let orgs;
    try {
      orgs = await provision.listOrgs();
    } catch (err) {
      await send(`⚠️ Can't reach the web app to list organisations: ${err.message}`);
      return;
    }
    if (orgs.length === 0) {
      await send('No organisations exist in the web app yet. Create one there first, then /addbot.');
      return;
    }
    flows.set(chatId, { data: { orgs } });
    await send('➕ <b>New bot</b>\n\nStep 1/5 — send a short id (slug), e.g. <code>corbu-dexters</code>:');
  }

  async function advanceFlow(chatId, text, messageId) {
    const flow = flows.get(chatId);
    const d = flow.data;
    try {
      if (d.id === undefined) {
        d.id = text.toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (!d.id) throw new Error('That id is empty after cleanup — use letters, numbers, hyphens.');
        await send(`Step 2/5 — display name for <b>${d.id}</b> (e.g. <code>Corbu Dexters</code>):`);
      } else if (d.name === undefined) {
        d.name = text;
        const list = d.orgs.map((o, i) => `${i + 1}. <b>${o.name}</b>`).join('\n');
        await send(`Step 3/5 — which organisation? Reply with the number:\n\n${list}`);
      } else if (d.orgId === undefined) {
        const n = parseInt(text.trim(), 10);
        if (!Number.isInteger(n) || n < 1 || n > d.orgs.length) throw new Error(`Reply with a number between 1 and ${d.orgs.length}.`);
        const org = d.orgs[n - 1];
        d.orgId = org.id;
        d.orgName = org.name;
        await send(`Step 4/5 — level for <b>${d.orgName}</b>? Reply <code>dev</code> or <code>client</code>:`);
      } else if (d.level === undefined) {
        const level = text.toLowerCase();
        if (!BOT_LEVELS.includes(level)) throw new Error('Level must be dev or client.');
        d.level = level;
        // No fixed admin chat — every subscriber, including you, opts in from /start
        // like anyone else. Fine for both dev and client bots on a multi-tenant setup.
        d.adminChatId = '';
        await send('Step 5/5 — paste the bot token. ⚠️ This message will be deleted immediately for safety.');
      } else {
        d.token = text.trim();
        // Delete the message that contained the token before doing anything else.
        try { await bot.deleteMessage(chatId, messageId); } catch { /* ignore */ }
        flows.delete(chatId);

        // Mint the org access token in the web app, then hand it to the new bot. The
        // web token is the single source of truth for org + level; the bot only ever
        // reads through it.
        const minted = await provision.mintToken(d.orgId, d.level, d.name || d.id);
        const created = await botManager.addBot({
          id: d.id,
          name: d.name,
          token: d.token,
          adminChatId: d.adminChatId,
          apiToken: minted.token,
          level: d.level,
        });
        await send(
          `✅ Connected <b>${created.name}</b> (<code>${created.id}</code>, ${created.level}) to <b>${d.orgName}</b>. It is now live.\n\n` +
          `Nobody is subscribed yet — message the new bot <code>/start</code> and tap <b>✅ Opt In</b> to receive live updates.`
        );
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
      `${b.running ? '🟢' : '🔴'} <b>${b.name}</b> (<code>${b.id}</code>) — ${b.level}`);
    await send('📋 <b>Bots</b>\n\n' + lines.join('\n'));
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

  async function cmdSetLevel(args) {
    const [id, level] = args.split(/\s+/);
    if (!id || !level) return send('Usage: /setlevel &lt;id&gt; dev|client');
    const lvl = level.toLowerCase();
    if (!BOT_LEVELS.includes(lvl)) return send('Level must be dev or client.');
    try {
      // Change the level on the web token first (the real authority), then update the
      // bot's cached copy + hot-swap its runtime so it takes effect immediately.
      const bot = botManager.list().find((b) => b.id === id);
      if (!bot) throw new Error(`No bot with id "${id}"`);
      const tokenId = bot.apiToken.split('.')[0];
      await provision.setLevel(tokenId, lvl);
      const updated = await botManager.setLevel(id, lvl);
      await send(`✅ <b>${updated.id}</b> is now <b>${updated.level}</b>.`);
    } catch (err) {
      await send(`⚠️ ${err.message}`);
    }
  }

  bot.on('message', (msg) => handle(msg).catch((err) => console.error('[manager] handle error:', err)));
  console.log('Manager bot started (owner-gated).');
  return bot;
}
