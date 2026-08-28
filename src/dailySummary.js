import { dateStrToSortKey, lpad, rpad, dashes, formatPerDeviceTotals } from './utils.js';

export function groupSessionsByDate(sessions) {
  const byDate = {};
  const dateOrder = [];
  sessions.forEach((s) => {
    if (!byDate[s.date]) {
      byDate[s.date] = [];
      dateOrder.push(s.date);
    }
    byDate[s.date].push(s);
  });
  dateOrder.sort((a, b) => {
    const ka = dateStrToSortKey(a), kb = dateStrToSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return { byDate, dateOrder };
}

// Shows, per day: total discoveries (sessions) and unique-tag count per discovery.
// Dev also gets each round's per-device breakdown and the day-wide unique-tag roll-up;
// client sees only Time | Combined and none of the tag-ID detail.
//
// `sessions` is the (possibly partial) chunk of rows to render in *this* message;
// `allSessions` — defaulting to `sessions` — is the whole day, used for the header
// count and the day-wide unique-tag roll-up so those stay accurate even when a day
// has been split across several messages (see formatDailySummaryMessages below).
export function formatDailySummary(dateStr, sessions, level = 'dev', { partLabel = null, includeUniqueBlock = true, allSessions = sessions } = {}) {
  const isClient = level === 'client';
  const sorted = [...sessions].sort((a, b) => a.time.localeCompare(b.time));

  const C = { TIME: 8, COMBINED: 8, PERDEV: 18 };
  const rows = isClient
    ? [lpad('Time', C.TIME) + ' | ' + lpad('Combined', C.COMBINED), dashes(C.TIME) + '-+-' + dashes(C.COMBINED)]
    : [
        lpad('Time', C.TIME) + ' | ' + lpad('Combined', C.COMBINED) + ' | ' + rpad('Per-Device', C.PERDEV),
        dashes(C.TIME) + '-+-' + dashes(C.COMBINED) + '-+-' + dashes(C.PERDEV),
      ];
  sorted.forEach((s) => {
    rows.push(
      isClient
        ? lpad(s.time, C.TIME) + ' | ' + lpad(s.total, C.COMBINED)
        : lpad(s.time, C.TIME) + ' | ' + lpad(s.total, C.COMBINED) + ' | ' + rpad(formatPerDeviceTotals(s.perDeviceTotals), C.PERDEV)
    );
  });
  rows.push(rows[1]); // closing divider matches the header divider

  const discoveryWord = `discover${allSessions.length !== 1 ? 'ies' : 'y'}`;
  const partSuffix = partLabel ? ` (part ${partLabel})` : '';

  if (isClient) {
    const header = `📆 <b>${dateStr}</b> — ${allSessions.length} ${discoveryWord}${partSuffix}\n\n`;
    return header + '<pre>' + rows.join('\n') + '</pre>';
  }

  const header = `📆 <b>${dateStr}</b> — ${allSessions.length} ${discoveryWord}${partSuffix}\n` +
    `<i>Combined = deduped unique IDs across all devices for that round. Per-Device = each device's own count.</i>\n\n`;
  const table = '<pre>' + rows.join('\n') + '</pre>';

  if (!includeUniqueBlock) return header + table;

  const seen = new Set();
  const uniqueIds = [];
  allSessions.forEach((s) => s.tags.forEach((t) => {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      uniqueIds.push(t.id);
    }
  }));
  uniqueIds.sort();
  const idLines = [];
  for (let i = 0; i < uniqueIds.length; i += 6) idLines.push(uniqueIds.slice(i, i + 6).join(' '));
  const uniqueBlock = `<pre>Unique tags for the day (${uniqueIds.length}):\n${idLines.join('\n')}</pre>`;

  return header + table + '\n\n' + uniqueBlock;
}

// Telegram rejects any text message over 4096 UTF-16 units (HTML tags included, since
// they count toward the raw text sent to the API even though they don't render). A
// day polled every 15 minutes runs to 90+ rows, which alone can clear that limit — and
// since callers only catch-and-log a failed sendMessage, a single oversized day used to
// mean the whole "3d Sum" / "7d Sum" button silently did nothing. Leaves real headroom
// below the hard 4096 cap for count/formatting variance across dev vs. client rows.
const MAX_MESSAGE_LEN = 3500;

// Recursively halves `sessions` until every half's rendered message (checked with the
// unique-tag block included, since that's the worst case — only the actual last chunk
// keeps it, but any chunk could end up being that one) fits under the limit.
function splitSessionsForLimit(dateStr, sessions, level, daySessions, maxLen) {
  if (sessions.length <= 1) return [sessions];
  const probe = formatDailySummary(dateStr, sessions, level, { includeUniqueBlock: true, allSessions: daySessions });
  if (probe.length <= maxLen) return [sessions];
  const mid = Math.ceil(sessions.length / 2);
  return [
    ...splitSessionsForLimit(dateStr, sessions.slice(0, mid), level, daySessions, maxLen),
    ...splitSessionsForLimit(dateStr, sessions.slice(mid), level, daySessions, maxLen),
  ];
}

// Renders one day as one or more Telegram-safe messages, splitting the table across
// messages (each carrying its own header + "(part i/n)" label) when the day is too
// long for a single message. The day-wide discovery count and unique-tag roll-up stay
// correct in every part; the unique-tag block itself is only attached to the last part.
export function formatDailySummaryMessages(dateStr, sessions, level = 'dev', maxLen = MAX_MESSAGE_LEN) {
  if (sessions.length === 0) return [formatDailySummary(dateStr, sessions, level)];
  const chunks = splitSessionsForLimit(dateStr, sessions, level, sessions, maxLen);
  return chunks.map((chunkSessions, i) => formatDailySummary(dateStr, chunkSessions, level, {
    partLabel: chunks.length > 1 ? `${i + 1}/${chunks.length}` : null,
    includeUniqueBlock: i === chunks.length - 1,
    allSessions: sessions,
  }));
}
