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

async function main() {
  console.log(`Farmranger Tag Bot starting. Units: ${config.unitIds.join(', ')}. Poll interval: ${config.pollIntervalSeconds}s.`);
  const bot = createBot();
  const state = loadState();

  const tick = () => pollOnce(bot, state).catch((err) => console.error('Poll cycle failed:', err));
  await tick();
  setInterval(tick, config.pollIntervalSeconds * 1000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
