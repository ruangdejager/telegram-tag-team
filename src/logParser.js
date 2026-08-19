// Parses raw Farmranger unit log text into discovery blocks.
//
// Block header example:
//   *00:00:29(+02:00) Mon 06-Jul-2026 4019mV
//   ---------------------------------
//   Tag Discovery (advanced):
//   DeviceId,Hops,Wave,RSSI,BatMv,Move,Lat,Lon,FwPatch
//
//   3E1E,1,1,-68,3637,1,0,0,22
//   ...
//
//   Total devices discovered: 11
//   ---------------------------------
//
// The device now self-describes its own column order via a CSV header line
// right after "Tag Discovery (...):"  — column order is NOT assumed to be
// fixed (it has already changed between firmware versions), so it's read
// from that header every time rather than hardcoded.
//
// Two known modes, each with a different field set:
//   advanced: DeviceId,Hops,Wave,RSSI,BatMv,Move,Lat,Lon,FwPatch
//   basic:    DeviceId,BatMv,RSSI,Move,FwPatch,Lat,Lon,AgeS
// Older logs may have no mode label and no header line at all — those fall
// back to the original known column order.
//
// A block may instead contain "LOG TIMEOUT" somewhere in its body, indicating the
// device failed to log a discovery round. Such blocks must be discarded entirely.

import { MONTHS } from './utils.js';

// Discovery-block anchor. Two formats coexist depending on firmware:
//   old (≤ v2.0.x): *09:00:12(+02:00) Wed 19-Aug-2026 4010mV\n
//   new (v2.1.x+):  *09:01:58(+02:00)\n
// The trailing lookahead `[ \t]*(?=\r?\n)` is what tells an anchor apart from an
// info line like `*09:02:07(+02:00) tag_fota: check requested` — anchors have
// nothing but whitespace after the offset (or after mV, in the old format), and
// info lines carry human-readable text there. For new-style bare anchors we carry
// the day/month/year forward from the previous full-format anchor in the same log.
const HEADER_RE = /\*(\d{2}:\d{2}:\d{2})\(([+-]\d{2}:\d{2})\)(?:\s+\w+\s+(\d{2})-(\w{3})-(\d{4})\s+(\d+)mV)?[ \t]*(?=\r?\n)/g;
// Captures the mode label (e.g. "advanced") and any trailing free text before the colon
// (e.g. " primary v2.0.1", which carries the reading device's own firmware version) —
// separately from the tag section body itself.
const TAG_SECTION_RE = /Tag Discovery(?:\s*\(([^)]*)\))?([^:\n]*):([\s\S]*?)Total devices discovered:/i;
const FW_VERSION_RE = /v?\d+(?:\.\d+){1,3}/i;

// Maps a normalized header column name to our internal field name.
const COLUMN_ALIASES = {
  deviceid: 'id',
  hops: 'hops',
  wave: 'waveCount',
  rssi: 'rssi',
  batmv: 'battery',
  move: 'movementState',
  lat: 'lat',
  lon: 'lon',
  fwpatch: 'fwVersionPatch',
  ages: 'gpsAgeSeconds',
};

// Fallback for logs predating the self-describing header line.
const DEFAULT_HEADER = 'DeviceId,Hops,RSSI,BatMv,Wave,Move,Lat,Lon,FwPatch';

function normalizeColumnName(name) {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function buildColumnMap(headerLine) {
  const map = {};
  headerLine.split(',').forEach((raw, index) => {
    const field = COLUMN_ALIASES[normalizeColumnName(raw)];
    if (field) map[field] = index;
  });
  return map;
}

function isHeaderLine(line) {
  return normalizeColumnName(line.split(',')[0] || '') === 'deviceid';
}

function toIsoTimestamp(time, offset, day, monStr, year) {
  const month = MONTHS[monStr];
  if (!month) return null;
  return `${year}-${month}-${day}T${time}${offset}`;
}

// Tag IDs are always 4 printable-ASCII characters, but occasionally arrive with a stray
// non-printable control character stuck to one edge — strip those, not interior chars.
function sanitizeTagId(raw) {
  let s = raw;
  const isPrintable = (ch) => {
    const code = ch.charCodeAt(0);
    return code >= 32 && code <= 126;
  };
  while (s.length && !isPrintable(s[0])) s = s.slice(1);
  while (s.length && !isPrintable(s[s.length - 1])) s = s.slice(0, -1);
  return s;
}

function parseTagRow(rowParts, columnMap) {
  const field = (name) => {
    const index = columnMap[name];
    if (index === undefined || index >= rowParts.length) return undefined;
    const value = rowParts[index];
    return value === '' ? undefined : value;
  };

  const id = field('id');
  const battery = parseFloat(field('battery'));
  const rssi = parseFloat(field('rssi'));
  // Guards against stray non-tag rows (e.g. a header line the mode-detection above
  // missed) — every real tag row has an id plus valid battery/RSSI readings.
  if (!id || Number.isNaN(battery) || Number.isNaN(rssi)) return null;

  const toIntOrNull = (name) => {
    const raw = field(name);
    if (raw === undefined) return null;
    const n = parseInt(raw, 10);
    return Number.isNaN(n) ? null : n;
  };

  const latRaw = field('lat');
  const lonRaw = field('lon');
  const lat = latRaw !== undefined ? parseInt(latRaw, 10) : NaN;
  const lon = lonRaw !== undefined ? parseInt(lonRaw, 10) : NaN;
  const hasGps = !Number.isNaN(lat) && !Number.isNaN(lon) && !(lat === 0 && lon === 0);

  return {
    id: sanitizeTagId(id).toUpperCase(),
    hops: toIntOrNull('hops'),
    waveCount: toIntOrNull('waveCount'),
    rssi,
    battery,
    movementState: toIntOrNull('movementState'),
    lat: hasGps ? lat / 1e6 : null,
    lon: hasGps ? lon / 1e6 : null,
    hasGps,
    fwVersionPatch: toIntOrNull('fwVersionPatch'),
    gpsAgeSeconds: toIntOrNull('gpsAgeSeconds'),
  };
}

function parseTagSection(sectionText) {
  const lines = sectionText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  let columnMap;
  let dataLines;
  if (isHeaderLine(lines[0])) {
    columnMap = buildColumnMap(lines[0]);
    dataLines = lines.slice(1);
  } else {
    columnMap = buildColumnMap(DEFAULT_HEADER);
    dataLines = lines;
  }

  const tags = [];
  for (const line of dataLines) {
    const tag = parseTagRow(line.split(',').map((p) => p.trim()), columnMap);
    if (tag) tags.push(tag);
  }
  return tags;
}

// Parses all discovery blocks out of a single device's raw log text.
export function parseLogText(fullText, unitId) {
  const blocks = [];
  const matches = [...fullText.matchAll(HEADER_RE)];
  // Carry the last-seen date and unit battery forward across matches so
  // bare-timestamp anchors (new firmware) inherit them from an earlier full anchor
  // in the same fetch. If we've never seen a full anchor, we can't produce a valid
  // ISO timestamp for a bare one, so those blocks are skipped rather than pushed
  // with a broken date.
  let lastDay, lastMonStr, lastYear, lastBatteryMv;

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const [, time, offset, day, monStr, year, batteryMv] = m;
    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : fullText.length;
    const body = fullText.slice(bodyStart, bodyEnd);

    if (day) { lastDay = day; lastMonStr = monStr; lastYear = year; lastBatteryMv = batteryMv; }
    const effDay = day ?? lastDay;
    const effMon = monStr ?? lastMonStr;
    const effYear = year ?? lastYear;
    const effBatt = batteryMv ?? lastBatteryMv;
    if (!effDay) continue; // bare anchor before any full anchor — can't date it

    const timestamp = toIsoTimestamp(time, offset, effDay, effMon, effYear);
    const dateStr = `${effDay}-${effMon}-${effYear}`;

    const base = {
      unitId,
      timestamp,
      date: dateStr,
      time,
      unitBatteryMv: effBatt ? parseInt(effBatt, 10) : null,
    };

    if (/LOG TIMEOUT/i.test(body)) {
      blocks.push({ ...base, isTimeout: true, tags: [], total: 0 });
      continue;
    }

    const totalMatch = body.match(/Total devices discovered:\s*(\d+)/i);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    const tagSectionMatch = body.match(TAG_SECTION_RE);
    const tags = tagSectionMatch ? parseTagSection(tagSectionMatch[3]) : [];
    // e.g. "Tag Discovery (advanced) primary v2.0.1:" -> the reading device's own fw version,
    // distinct from each tag's own fwVersionPatch reported in the row data.
    const readerInfoText = tagSectionMatch ? tagSectionMatch[2] : '';
    const fwMatch = readerInfoText.match(FW_VERSION_RE);
    const readerFwVersion = fwMatch ? fwMatch[0] : null;

    blocks.push({ ...base, isTimeout: false, tags, total, readerFwVersion });
  }

  return blocks;
}
