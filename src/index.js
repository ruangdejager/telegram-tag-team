import { config } from './config.js';
import { fetchUnitLogText } from './apiClient.js';
import { parseLogText } from './logParser.js';
import { mergeSessions } from './sessionMerger.js';
import { formatSessionMessage, formatTimeoutAlert } from './formatter.js';
import { createBot, sendMessage, sendWithButtons } from './telegramBot.js';
import { loadState, saveState } from './state.js';
import { getRecipients, isOptedIn } from './subscribers.js';

const FETCH_BUFFER_MINUTES = 10; // re-fetch a little before lastProcessedTimestamp to catch late-arriving cross-device blocks

async function pollOnce(bot, state) {
  const now = new Date();
  const fromOverride = state.lastProcessedTimestamp
    ? new Date(new Date(state.lastProcessedTimestamp).getTime() - FETCH_BUFFER_MINUTES * 60 * 1000)
    : undefined;

  const blocksByUnit = {};
  for (const unitId of config.unitIds) {
    try {
      const text = await fetchUnitLogText(unitId, now, fromOverride);
      blocksByUnit[unitId] = parseLogText(text, unitId);
    } catch (err) {
      console.error(`Failed to fetch/parse logs for unit ${unitId}:`, err.message);
      blocksByUnit[unitId] = [];
    }
  }

  const sessions = mergeSessions(blocksByUnit)
    .filter((s) => !state.lastProcessedTimestamp || s.timestamp > state.lastProcessedTimestamp)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  for (const session of sessions) {
    try {
      const recipients = getRecipients();
      if (session.discarded) {
        console.log(`Session ${session.timestamp}: LOG TIMEOUT on ${session.timeoutUnitIds.join(', ')} — discarding and alerting.`);
        const text = formatTimeoutAlert(session);
        for (const chatId of recipients) await sendMessage(bot, chatId, text);
      } else if (session.total > 0) {
        console.log(`Session ${session.timestamp}: ${session.total} unique tag(s) across ${session.involvedUnitIds.join(', ')}.`);
        const text = formatSessionMessage(session);
        for (const chatId of recipients) await sendWithButtons(bot, chatId, text, isOptedIn(chatId));
      }
      state.lastProcessedTimestamp = session.timestamp;
      saveState(state);
    } catch (err) {
      console.error(`Failed to send session ${session.timestamp}:`, err.message);
      break; // stop here, retry this session (and later ones) on the next poll
    }
  }
}

// Farmranger uploads new logs to the server at :15 past every hour, so we poll
// at :20 past every hour — a small safety margin without wasting per-hour requests.
// (Discovery rounds themselves may only happen every few hours; the poll cadence
// is just how often we *check* for a new one.)
function msUntilNextPollTick(now = new Date()) {
  const next = new Date(now);
  next.setMinutes(config.pollMinute, 0, 0);
  if (next <= now) next.setHours(next.getHours() + 1);
  return next.getTime() - now.getTime();
}

function scheduleNextTick(bot, state) {
  const delayMs = msUntilNextPollTick();
  const fireAt = new Date(Date.now() + delayMs);
  console.log(`Next poll scheduled for ${fireAt.toISOString()} (in ${Math.round(delayMs / 1000)}s).`);
  setTimeout(async () => {
    try {
      await pollOnce(bot, state);
    } catch (err) {
      console.error('Poll cycle failed:', err);
    }
    scheduleNextTick(bot, state);
  }, delayMs);
}

async function main() {
  console.log(`Farmranger Tag Bot starting. Units: ${config.unitIds.join(', ')}. Polling at :${String(config.pollMinute).padStart(2, '0')} past every hour.`);
  const bot = createBot();
  const state = loadState();

  // Run once on startup to catch anything missed since last shutdown, then align to schedule.
  await pollOnce(bot, state).catch((err) => console.error('Startup poll failed:', err));
  scheduleNextTick(bot, state);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
