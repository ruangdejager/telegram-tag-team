import { config } from './config.js';
import { fetchUnitLogText } from './apiClient.js';
import { parseLogText } from './logParser.js';
import { mergeSessions } from './sessionMerger.js';

// Fetches and merges discovery sessions across all configured units for a time range.
// hoursBack XOR fromDate should be given; omit both for "all time" (from config.historyStart).
// No query ever reaches earlier than config.historyStart, since device data isn't valid before it.
export async function fetchHistorySessions({ hoursBack, fromDate } = {}) {
  const now = new Date();
  let from = fromDate ?? (hoursBack != null ? new Date(now.getTime() - hoursBack * 60 * 60 * 1000) : config.historyStart);

  if (from < config.historyStart) from = config.historyStart;

  const blocksByUnit = {};
  for (const unitId of config.unitIds) {
    const text = await fetchUnitLogText(unitId, now, from);
    blocksByUnit[unitId] = parseLogText(text, unitId);
  }

  return mergeSessions(blocksByUnit)
    .filter((s) => !s.discarded && s.total > 0)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
