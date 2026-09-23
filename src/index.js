import { appConfig } from './config.js';
import { createBotManager } from './botManager.js';
import { startManagerBot } from './managerBot.js';

// Self-rescheduling setTimeout, re-armed only after the previous cycle finishes —
// never setInterval — so a slow poll (a stalled fetch, a burst of sends) can't
// stack a second cycle on top of itself.
function scheduleNextTick(botManager) {
  const delayMs = appConfig.pollSeconds * 1000;
  return setTimeout(async () => {
    await botManager.pollAll();
    pollTimer = scheduleNextTick(botManager);
  }, delayMs);
}

let pollTimer = null;

async function main() {
  const botManager = createBotManager();
  const started = botManager.startAll();
  console.log(`Started ${started.length} bot(s): ${started.join(', ') || '(none)'}. Polling every ${appConfig.pollSeconds}s.`);

  const managerBot = startManagerBot(botManager);

  // On redeploy/restart, Railway sends SIGTERM to the old container. Without releasing
  // each bot's Telegram long-poll here, the old and new container briefly hold the same
  // connection open and fight over it (Telegram 409s + a burst of failed handler calls)
  // until the stale one times out server-side. Stopping cleanly avoids that entirely.
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} received, shutting down gracefully...`);
    if (pollTimer) clearTimeout(pollTimer);
    if (managerBot) {
      try { await managerBot.stopPolling({ cancel: true }); } catch (err) { console.error('Error stopping manager bot:', err.message); }
    }
    await botManager.stopAll();
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Catch anything missed since last shutdown, then start the regular cycle.
  await botManager.pollAll();
  pollTimer = scheduleNextTick(botManager);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
