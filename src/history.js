import { appConfig } from './config.js';
import { buildSessionsFromReadings } from './webClient.js';

// Fetches and rebuilds discovery sessions for a time range from the tagexplore-web
// database (via the bot's org-scoped web client) — the bot no longer scrapes or
// parses any logs itself. hoursBack XOR fromDate should be given; omit both for
// "all time" (from historyStart). No query ever reaches earlier than
// appConfig.historyStart, since device data isn't valid before it.
export async function fetchHistorySessions(webClient, { hoursBack, fromDate } = {}) {
  const now = new Date();
  let from = fromDate ?? (hoursBack != null ? new Date(now.getTime() - hoursBack * 60 * 60 * 1000) : appConfig.historyStart);

  if (from < appConfig.historyStart) from = appConfig.historyStart;

  const { readings, rounds } = await webClient.fetchReadings(from.getTime(), now.getTime());

  return buildSessionsFromReadings(readings, rounds)
    .filter((s) => !s.discarded && s.total > 0 && new Date(s.timestamp) >= from)
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
