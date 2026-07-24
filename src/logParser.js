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

const HEADER_RE = /\*(\d{2}:\d{2}:\d{2})\(([+-]\d{2}:\d{2})\)\s+\w+\s+(\d{2})-(\w{3})-(\d{4})\s+(\d+)mV/g;
const TAG_SECTION_RE = /Tag Discovery(?:\s*\([^)]*\))?:([\s\S]*?)Total devices discovered:/i;

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
    id: id.toUpperCase(),
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

  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const [, time, offset, day, monStr, year, batteryMv] = m;
    const bodyStart = m.index + m[0].length;
    const bodyEnd = i + 1 < matches.length ? matches[i + 1].index : fullText.length;
    const body = fullText.slice(bodyStart, bodyEnd);

    const timestamp = toIsoTimestamp(time, offset, day, monStr, year);
    const dateStr = `${day}-${monStr}-${year}`;

    const base = {
      unitId,
      timestamp,
      date: dateStr,
      time,
      unitBatteryMv: parseInt(batteryMv, 10),
    };

    if (/LOG TIMEOUT/i.test(body)) {
      blocks.push({ ...base, isTimeout: true, tags: [], total: 0 });
      continue;
    }

    const totalMatch = body.match(/Total devices discovered:\s*(\d+)/i);
    const total = totalMatch ? parseInt(totalMatch[1], 10) : 0;

    const tagSectionMatch = body.match(TAG_SECTION_RE);
    const tags = tagSectionMatch ? parseTagSection(tagSectionMatch[1]) : [];

    blocks.push({ ...base, isTimeout: false, tags, total });
  }

  return blocks;
}
