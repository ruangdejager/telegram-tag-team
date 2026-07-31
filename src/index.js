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
  setTimeout(async () => {
    await botManager.pollAll();
    scheduleNextTick(botManager);
  }, delayMs);
}

async function main() {
  seedAndMigrate();

  const botManager = createBotManager();
  const started = botManager.startAll();
  console.log(`Started ${started.length} bot(s): ${started.join(', ') || '(none)'}. Polling at :${String(appConfig.pollMinute).padStart(2, '0')} past every hour.`);

  startManagerBot(botManager);

  // Catch anything missed since last shutdown, then align to the hourly schedule.
  await botManager.pollAll();
  scheduleNextTick(botManager);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
