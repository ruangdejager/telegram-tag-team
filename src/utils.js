export const MONTHS = {
  Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
  Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
};

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const JHB_OFFSET_MS = 2 * 60 * 60 * 1000; // Africa/Johannesburg: fixed UTC+2, no DST

// Converts 'DD-Mon-YYYY' to 'YYYY-MM-DD' so dates sort correctly as strings.
export function dateStrToSortKey(dateStr) {
  const [day, mon, year] = dateStr.split('-');
  return `${year}-${MONTHS[mon]}-${day}`;
}

// Formats a UTC instant (epoch ms) as Johannesburg-local date/time/ISO parts.
export function epochToJhb(epochMs) {
  const shifted = new Date(epochMs + JHB_OFFSET_MS);
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  const mon = MONTH_NAMES[shifted.getUTCMonth()];
  const year = shifted.getUTCFullYear();
  const time = [shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
  const date = `${day}-${mon}-${year}`;
  return { date, time, iso: `${year}-${MONTHS[mon]}-${day}T${time}+02:00` };
}

export function lpad(str, width) {
  str = String(str);
  while (str.length < width) str = ' ' + str;
  return str.substring(0, width);
}

export function rpad(str, width) {
  str = String(str);
  while (str.length < width) str = str + ' ';
  return str.substring(0, width);
}

export function dashes(n) {
  return '-'.repeat(n);
}

// Short label for a unit ID in compact table columns, e.g. '866049074634379' -> '379'.
export function shortUnitId(unitId) {
  return String(unitId).slice(-3);
}

// e.g. { A: 7, B: 8 } -> 'A:7 B:8'
export function formatPerDeviceTotals(perDeviceTotals) {
  return Object.entries(perDeviceTotals)
    .map(([unitId, count]) => `${shortUnitId(unitId)}:${count}`)
    .join(' ');
}

// Tag IDs must be exactly 4 printable-ASCII chars. Parses free text (space/comma
// separated) into a validated, uppercase, unique list; returns { ids, invalid }.
export function parseTagIdList(input) {
  const tokens = String(input || '').split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
  const ids = [];
  const invalid = [];
  const seen = new Set();
  for (const tok of tokens) {
    const up = tok.toUpperCase();
    if (/^[\x21-\x7E]{4}$/.test(up)) {
      if (!seen.has(up)) {
        seen.add(up);
        ids.push(up);
      }
    } else {
      invalid.push(tok);
    }
  }
  return { ids, invalid };
}
