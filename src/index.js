import { appConfig } from './config.js';
import { seedAndMigrate } from './bootstrap.js';
import { createBotManager } from './botManager.js';
import { startManagerBot } from './managerBot.js';

function msUntilNextPollTick(now = new Date()) {
  const next = new Date(now);
  next.setMinutes(appConfig.pollMinute, 0, 0);
  if (next <= now) next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNextTick(botManager) {
  const delayMs = msUntilNextPollTick();
  console.log(`Next poll for all bots at ${new Date(Date.now() + delayMs).toISOString()} (in ${Math.round(delayMs / 1000)}s).`);
  return setTimeout(async () => {
    await botManager.pollAll();
    pollTimer = scheduleNextTick(botManager);
  }, delayMs);
}

let pollTimer = null;

async function main() {
  seedAndMigrate();

  const botManager = createBotManager();
  const started = botManager.startAll();
  console.log(`Started ${started.length} bot(s): ${started.join(', ') || '(none)'}. Polling at :${String(appConfig.pollMinute).padStart(2, '0')} past every hour.`);

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

  // Catch anything missed since last shutdown, then align to the hourly schedule.
  await botManager.pollAll();
  pollTimer = scheduleNextTick(botManager);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
