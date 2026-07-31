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
export function formatDailySummary(dateStr, sessions, level = 'dev') {
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

  const discoveryWord = `discover${sessions.length !== 1 ? 'ies' : 'y'}`;

  if (isClient) {
    const header = `📆 <b>${dateStr}</b> — ${sessions.length} ${discoveryWord}\n\n`;
    return header + '<pre>' + rows.join('\n') + '</pre>';
  }

  const seen = new Set();
  const uniqueIds = [];
  sessions.forEach((s) => s.tags.forEach((t) => {
    if (!seen.has(t.id)) {
      seen.add(t.id);
      uniqueIds.push(t.id);
    }
  }));
  uniqueIds.sort();
  const idLines = [];
  for (let i = 0; i < uniqueIds.length; i += 6) idLines.push(uniqueIds.slice(i, i + 6).join(' '));

  const header = `📆 <b>${dateStr}</b> — ${sessions.length} ${discoveryWord}\n` +
    `<i>Combined = deduped unique IDs across all devices for that round. Per-Device = each device's own count.</i>\n\n`;
  const table = '<pre>' + rows.join('\n') + '</pre>\n\n';
  const uniqueBlock = `<pre>Unique tags for the day (${uniqueIds.length}):\n${idLines.join('\n')}</pre>`;

  return header + table + uniqueBlock;
}
