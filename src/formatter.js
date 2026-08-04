import { formatPerDeviceTotals } from './utils.js';
import { batteryEmoji, BATTERY_LEGEND_TEXT } from './batteryStatus.js';

function formatDeviceBreakdown(session) {
  const lines = session.involvedUnitIds.map((unitId) => {
    const fw = session.perDeviceFwVersion[unitId] || 'unknown';
    const count = session.perDeviceTotals[unitId];
    return `${unitId},${fw}:${count}`;
  });
  lines.push(`Combined -> ${session.total}`);
  return lines.join('\n');
}

function lpad(str, width) {
  str = String(str);
  while (str.length < width) str = ' ' + str;
  return str.substring(0, width);
}

function dashes(n) {
  return '-'.repeat(n);
}

// Dev table columns. Presence varies by discovery mode (advanced has Hops/Waves,
// basic doesn't; fw version may or may not be reported) — each optional column
// is only shown if at least one tag in the session actually has a value for it.
// The "St" (status) column shows a coloured dot per the dev battery-status
// thresholds (batteryStatus.js), which the Battery chart bars also use.
const DEV_COLUMN_DEFS = [
  { label: 'Tag ID', width: 6, always: true, get: (t) => t.id },
  { label: 'Hops', width: 4, get: (t) => t.hops },
  { label: 'RSSI', width: 6, always: true, get: (t) => t.rssi },
  { label: 'Batt', width: 6, always: true, get: (t) => t.battery },
  { label: 'St', width: 3, always: true, get: (t) => batteryEmoji(t.battery) },
  { label: 'Waves', width: 5, get: (t) => t.waveCount },
  { label: 'Mov', width: 4, get: (t) => t.movementState },
  { label: 'GPS', width: 4, always: true, get: (t) => (t.hasGps ? 'Y' : 'N') },
  { label: 'FW', width: 5, get: (t) => t.fwVersionPatch },
];

// Client sees only: Tag ID + a battery-health dot + GPS Y/N. No raw mV, no FW/IMEI/etc.
// Uses the same 4-colour battery scheme as dev so operator + client agree on which
// tags are "low" — client just doesn't see the raw mV number or the thresholds.
const CLIENT_COLUMN_DEFS = [
  { label: 'Tag ID', width: 6, get: (t) => t.id },
  { label: 'Batt', width: 4, get: (t) => batteryEmoji(t.battery) },
  { label: 'GPS', width: 3, get: (t) => (t.hasGps ? 'Y' : 'N') },
];

function formatClientSession(session) {
  // The unique-count is the client's headline metric — make it the biggest thing on screen.
  const header =
    `🏷 <b>Tag Discovery — ${session.time} (${session.date})</b>\n` +
    `<b>Unique tags detected: ${session.total}</b>\n` +
    `<i>${BATTERY_LEGEND_TEXT}</i>\n\n`;

  const cols = CLIENT_COLUMN_DEFS;
  const div = cols.map((c) => dashes(c.width)).join('-+-');
  const rows = [cols.map((c) => lpad(c.label, c.width)).join(' | '), div];
  session.tags.forEach((t) => {
    rows.push(cols.map((c) => lpad(c.get(t), c.width)).join(' | '));
  });
  rows.push(div);

  let full = header + '<pre>' + rows.join('\n') + '</pre>';
  if (full.length > 4000) {
    while (rows.length > 4 && (header + '<pre>' + rows.join('\n') + '</pre>').length > 4000) {
      rows.splice(rows.length - 3, 1);
    }
    rows.push('(list truncated)');
    full = header + '<pre>' + rows.join('\n') + '</pre>';
  }
  return full;
}

function formatDevSession(session) {
  const header =
    `🏷 <b>Tag Discovery — ${session.time} (${session.date})</b>\n` +
    `<i>Discovery took ${session.durationSeconds}s</i>\n` +
    `<i>St: 🟢≥3800mV Fully charged · 🔵≥3600mV Good · 🟠≥3500mV watch · 🔴&lt;3500mV low battery (gps not allowed)</i>\n` +
    `<pre>${formatDeviceBreakdown(session)}</pre>\n\n`;

  const activeCols = DEV_COLUMN_DEFS.filter(
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

export function formatSessionMessage(session, level = 'dev') {
  return level === 'client' ? formatClientSession(session) : formatDevSession(session);
}

// Minimal headline view: just the discovery time + unique-tag total, no table,
// no device breakdown. Used by the "Latest Count" button and the opted-in push
// notification (both levels — there's nothing level-specific to hide here).
export function formatLatestCount(session) {
  return (
    `🏷 <b>Tag Discovery — ${session.time} (${session.date})</b>\n` +
    `<i>Unique tags detected:</i>\n\n` +
    `<b>${session.total}</b>`
  );
}

// Client-only battery status list: Tag ID + status dot only (no GPS column, no
// raw mV) — the text analog of dev's Plotly "Battery Level List" chart. `series`
// is the buildTagSeries(sessions) shape (tag id -> array of readings); uses each
// tag's latest reading, sorted worst-battery-first to match the chart's ordering.
export function formatBatteryStatusList(series) {
  const tags = Object.keys(series)
    .map((id) => ({ id, latest: series[id][series[id].length - 1].battery }))
    .sort((a, b) => a.latest - b.latest);

  const header = `🔋 <b>Battery Status</b>\n<i>${BATTERY_LEGEND_TEXT}</i>\n\n`;

  if (tags.length === 0) return header + '<i>No battery data yet.</i>';

  const cols = [{ label: 'Tag ID', width: 6 }, { label: 'St', width: 3 }];
  const div = cols.map((c) => dashes(c.width)).join('-+-');
  const rows = [cols.map((c) => lpad(c.label, c.width)).join(' | '), div];
  tags.forEach((t) => {
    rows.push(lpad(t.id, 6) + ' | ' + lpad(batteryEmoji(t.latest), 3));
  });
  rows.push(div);

  return header + '<pre>' + rows.join('\n') + '</pre>';
}

export function formatTimeoutAlert(session, level = 'dev') {
  // Client sees a generic notice without device (IMEI) identifiers.
  if (level === 'client') {
    return (
      `⚠️ <b>Discovery skipped</b>\n\n` +
      `The discovery round around <b>${session.timestamp}</b> was skipped due to a device error and has been dropped.`
    );
  }
  return (
    `⚠️ <b>LOG TIMEOUT detected</b>\n\n` +
    `Session around <b>${session.timestamp}</b> was discarded because unit(s) ` +
    `<b>${session.timeoutUnitIds.join(', ')}</b> reported a LOG TIMEOUT.\n\n` +
    `All data for this discovery round (across all devices: ${session.involvedUnitIds.join(', ')}) has been dropped.`
  );
}
