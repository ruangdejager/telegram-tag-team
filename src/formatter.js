import { formatPerDeviceTotals } from './utils.js';

function lpad(str, width) {
  str = String(str);
  while (str.length < width) str = ' ' + str;
  return str.substring(0, width);
}

function dashes(n) {
  return '-'.repeat(n);
}

// Column presence varies by discovery mode (advanced has Hops/Waves, basic doesn't;
// fw version may or may not be reported) — each optional column is only shown if at
// least one tag in the session actually has a value for it.
const COLUMN_DEFS = [
  { label: 'Tag ID', width: 6, always: true, get: (t) => t.id },
  { label: 'Hops', width: 4, get: (t) => t.hops },
  { label: 'RSSI', width: 6, always: true, get: (t) => t.rssi },
  { label: 'Batt', width: 6, always: true, get: (t) => t.battery },
  { label: 'Waves', width: 5, get: (t) => t.waveCount },
  { label: 'Mov', width: 4, get: (t) => t.movementState },
  { label: 'GPS', width: 4, always: true, get: (t) => (t.hasGps ? 'Y' : 'N') },
  { label: 'FW', width: 5, get: (t) => t.fwVersionPatch },
];

export function formatSessionMessage(session) {
  const header = `🏷 <b>Tag Discovery — ${session.time} (${session.date})</b>\n` +
    `<i>Per-device: ${formatPerDeviceTotals(session.perDeviceTotals)} → Combined unique: ${session.total}</i>\n\n`;

  const activeCols = COLUMN_DEFS.filter(
    (c) => c.always || session.tags.some((t) => c.get(t) !== null && c.get(t) !== undefined)
  );
  const div = activeCols.map((c) => dashes(c.width)).join('-+-');
  const rows = [
    activeCols.map((c) => lpad(c.label, c.width)).join(' | '),
    div,
  ];

  session.tags.forEach((t) => {
    const cells = activeCols.map((c) => {
      const v = c.get(t);
      return lpad(v === null || v === undefined ? '' : v, c.width);
    });
    rows.push(cells.join(' | '));
  });
  rows.push(div);
  rows.push(`Total: ${session.total} tag${session.total !== 1 ? 's' : ''}`);

  let full = header + '<pre>' + rows.join('\n') + '</pre>';
  if (full.length > 4000) {
    while (rows.length > 4 && (header + '<pre>' + rows.join('\n') + '</pre>').length > 4000) {
      rows.splice(rows.length - 3, 1);
    }
    rows[rows.length - 1] = `Total: ${session.total} tags (truncated)`;
    full = header + '<pre>' + rows.join('\n') + '</pre>';
  }
  return full;
}

export function formatTimeoutAlert(session) {
  return (
    `⚠️ <b>LOG TIMEOUT detected</b>\n\n` +
    `Session around <b>${session.timestamp}</b> was discarded because unit(s) ` +
    `<b>${session.timeoutUnitIds.join(', ')}</b> reported a LOG TIMEOUT.\n\n` +
    `All data for this discovery round (across all devices: ${session.involvedUnitIds.join(', ')}) has been dropped.`
  );
}
