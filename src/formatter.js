import { formatPerDeviceTotals } from './utils.js';

function lpad(str, width) {
  str = String(str);
  while (str.length < width) str = ' ' + str;
  return str.substring(0, width);
}

export function formatSessionMessage(session) {
  const header = `🏷 <b>Tag Discovery — ${session.time} (${session.date})</b>\n` +
    `<i>Per-device: ${formatPerDeviceTotals(session.perDeviceTotals)} → Combined unique: ${session.total}</i>\n\n`;

  const C = { ID: 6, HOPS: 4, RSSI: 5, BATT: 6, WAVE: 5, MOVE: 4 };
  const dashes = (n) => '-'.repeat(n);
  const div = dashes(C.ID) + '-+-' + dashes(C.HOPS) + '-+-' + dashes(C.RSSI) + '-+-' +
    dashes(C.BATT) + '-+-' + dashes(C.WAVE) + '-+-' + dashes(C.MOVE);
  const rows = [
    lpad('Tag ID', C.ID) + ' | ' + lpad('Hops', C.HOPS) + ' | ' + lpad('RSSI', C.RSSI) + ' | ' +
      lpad('Batt', C.BATT) + ' | ' + lpad('Waves', C.WAVE) + ' | ' + lpad('Mov', C.MOVE),
    div,
  ];

  session.tags.forEach((t) => {
    rows.push(
      lpad(t.id, C.ID) + ' | ' + lpad(t.hops, C.HOPS) + ' | ' + lpad(t.rssi, C.RSSI) + ' | ' +
        lpad(t.battery, C.BATT) + ' | ' + lpad(t.waveCount, C.WAVE) + ' | ' + lpad(t.movementState, C.MOVE)
    );
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
