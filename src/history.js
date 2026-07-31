import { appConfig } from './config.js';
import { fetchUnitLogText } from './apiClient.js';
import { parseLogText } from './logParser.js';
import { mergeSessions } from './sessionMerger.js';

// Fetches and merges discovery sessions across the given units for a time range.
// hoursBack XOR fromDate should be given; omit both for "all time" (from historyStart).
// No query ever reaches earlier than appConfig.historyStart, since device data isn't
// valid before it.
export async function fetchHistorySessions(unitIds, { hoursBack, fromDate } = {}) {
  const now = new Date();
  let from = fromDate ?? (hoursBack != null ? new Date(now.getTime() - hoursBack * 60 * 60 * 1000) : appConfig.historyStart);

  if (from < appConfig.historyStart) from = appConfig.historyStart;

  const blocksByUnit = {};
  for (const unitId of unitIds) {
    const text = await fetchUnitLogText(unitId, now, from);
    blocksByUnit[unitId] = parseLogText(text, unitId);
  }

  return mergeSessions(blocksByUnit)
    .filter((s) => !s.discarded && s.total > 0)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
