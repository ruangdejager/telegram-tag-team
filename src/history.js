import { appConfig } from './config.js';
import { fetchUnitLogText } from './apiClient.js';
import { parseLogText } from './logParser.js';
import { mergeSessions } from './sessionMerger.js';

// The Farmranger API's From filter matches each raw log line's own timestamp, but
// mergeSessions rounds that timestamp to the nearest 15-min bracket. A block logged
// just before a requested boundary (e.g. 23:58 for a "since midnight" query) can
// therefore round into the range we want (00:00) while still being excluded from the
// API response because 23:58 < From. Query a bit earlier than requested to catch
// those, then trim sessions back to the real boundary below.
const FETCH_LOOKBACK_MS = 2 * 60 * 60 * 1000;

// Fetches and merges discovery sessions across the given units for a time range.
// hoursBack XOR fromDate should be given; omit both for "all time" (from historyStart).
// No query ever reaches earlier than appConfig.historyStart, since device data isn't
// valid before it.
export async function fetchHistorySessions(unitIds, { hoursBack, fromDate } = {}) {
  const now = new Date();
  let from = fromDate ?? (hoursBack != null ? new Date(now.getTime() - hoursBack * 60 * 60 * 1000) : appConfig.historyStart);

  if (from < appConfig.historyStart) from = appConfig.historyStart;

  const fetchFrom = new Date(from.getTime() - FETCH_LOOKBACK_MS);
  const blocksByUnit = {};
  for (const unitId of unitIds) {
    const text = await fetchUnitLogText(unitId, now, fetchFrom);
    blocksByUnit[unitId] = parseLogText(text, unitId);
  }

  return mergeSessions(blocksByUnit)
    .filter((s) => !s.discarded && s.total > 0 && new Date(s.timestamp) >= from)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
