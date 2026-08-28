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

import { MONTHS, MONTH_NAMES } from './utils.js';

// Every timestamped log line starts with a "time mark":
//   dated: *21:11:04(+02:00) Thu 27-Aug-2026 4073mV HttpPost OK (1, 0|200, LTE|31)
//   bare:  *22:00:01(+02:00) gnss on (max-m10s)
// A mark is a *discovery anchor* only when nothing but whitespace follows it before
// the newline — that's what tells `*22:00:27(+02:00) ` (a discovery block header)
// apart from `*22:00:27(+02:00) frtag: session start` (an info line). Both kinds are
// collected here, because the info lines are what carry the calendar date on firmware
// that emits bare discovery anchors: v2.1.x drops to "minimal syslog mode" around a
// discovery round, so the anchor itself has no date and must inherit one from the
// dated lines around it (see resolveMarkDates).
const TIME_MARK_RE = /\*(\d{2}:\d{2}:\d{2})\(([+-]\d{2}:\d{2})\)(?:[ \t]+\w+[ \t]+(\d{2})-(\w{3})-(\d{4})[ \t]+(\d+)mV)?/g;
// Sticky: matched at the end of a time mark to test "only whitespace left on this line".
const LINE_END_RE = /[ \t]*(?=\r?\n)/y;
// Log lines are chronological, so a clock time that goes *backwards* means the day
// rolled over at midnight. Requiring a big backward step (rather than any decrease)
// keeps out-of-order jitter — repeated/duplicated lines a few seconds apart, or the
// interleaving of two devices' text — from being mistaken for a new day. A real
// rollover always shows up as a step back of nearly a full day, since log lines are
// only minutes apart.
const ROLLOVER_BACKSTEP_SECONDS = 6 * 60 * 60;
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

  const id0 = field('id');
  const id = id0 === undefined ? undefined : sanitizeTagId(id0).toUpperCase();
  const battery = parseFloat(field('battery'));
  const rssi = parseFloat(field('rssi'));
  // Guards against stray non-tag rows (e.g. a header line the mode-detection above
  // missed) — every real tag row has an id plus valid battery/RSSI readings.
  if (!id || Number.isNaN(battery) || Number.isNaN(rssi)) return null;
  // A real tag ID is at most 4 hex chars. Longer IDs are the firmware's own
  // pseudo-devices, not tags — a FOTA transfer logs a one-row "discovery" per chunk
  // with an 8-char progress ID (F9000000, F9000004, ... F9F9F9F9). Dropping them here
  // keeps them out of counts, charts and the missing-tag list.
  if (id.length > 4) return null;

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
    id,
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

// Pulls every timestamped mark out of the log, flagging the ones that are discovery
// anchors (nothing but whitespace after the timestamp) and capturing the calendar date
// on the ones that carry it.
function collectTimeMarks(fullText) {
  const marks = [];
  for (const m of fullText.matchAll(TIME_MARK_RE)) {
    const [, time, offset, day, monStr, year, batteryMv] = m;
    const end = m.index + m[0].length;
    LINE_END_RE.lastIndex = end;
    // A device that boots without a valid RTC logs the epoch date ("rtc invalid",
    // 01-Jan-1970) until it syncs. Those lines are no use as a date source and their
    // clock times are meaningless, so they're neither trusted nor carried forward.
    const invalidClock = Boolean(year) && Number(year) < 2000;
    marks.push({
      time,
      offset,
      day: invalidClock ? undefined : day,
      monStr: invalidClock ? undefined : monStr,
      year: invalidClock ? undefined : year,
      invalidClock,
      batteryMv: batteryMv ? parseInt(batteryMv, 10) : null,
      isAnchor: LINE_END_RE.test(fullText),
      bodyStart: end,
      index: m.index,
    });
  }
  return marks;
}

function timeToSeconds(time) {
  const [h, m, s] = time.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function shiftDate({ day, monStr, year }, deltaDays) {
  const d = new Date(Date.UTC(Number(year), Number(MONTHS[monStr]) - 1, Number(day)));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return {
    day: String(d.getUTCDate()).padStart(2, '0'),
    monStr: MONTH_NAMES[d.getUTCMonth()],
    year: String(d.getUTCFullYear()),
  };
}

// Gives every mark a calendar date and a unit battery reading, in place.
//
// Firmware ≥ v2.1.x logs the discovery anchor itself with no date (it enters "minimal
// syslog mode" for the round), so a date has to come from the ordinary log lines around
// it. Two passes:
//   forward  — carry the last dated line's date onto the bare marks that follow it,
//              advancing a day whenever the clock jumps backwards past midnight;
//   backward — do the same in reverse for bare marks that appear *before* the first
//              dated line in the fetched text, stepping a day back at each rollover.
// The backward pass matters because a fetch window often starts mid-day: without it,
// every discovery before the first dated line would be undatable and silently dropped.
function resolveMarkDates(marks) {
  let current = null;
  let lastSeconds = null;
  let battery = null;
  for (const mark of marks) {
    if (mark.invalidClock) continue; // epoch-dated boot line: neither a date source nor a step
    const seconds = timeToSeconds(mark.time);
    if (mark.day) {
      current = { day: mark.day, monStr: mark.monStr, year: mark.year };
      battery = mark.batteryMv;
    } else if (current && lastSeconds !== null && lastSeconds - seconds > ROLLOVER_BACKSTEP_SECONDS) {
      current = shiftDate(current, 1);
    }
    mark.date = current;
    if (mark.batteryMv === null) mark.batteryMv = battery;
    lastSeconds = seconds;
  }

  let nextDate = null;
  let nextSeconds = null;
  let nextBattery = null;
  for (let i = marks.length - 1; i >= 0; i--) {
    const mark = marks[i];
    if (mark.invalidClock) continue;
    const seconds = timeToSeconds(mark.time);
    if (mark.date) {
      nextDate = mark.date;
      nextSeconds = seconds;
      nextBattery = mark.batteryMv;
      continue;
    }
    if (!nextDate) continue; // no dated line anywhere after it either — undatable
    if (seconds - nextSeconds > ROLLOVER_BACKSTEP_SECONDS) nextDate = shiftDate(nextDate, -1);
    mark.date = nextDate;
    mark.batteryMv = nextBattery;
    nextSeconds = seconds;
  }
}

// Parses all discovery blocks out of a single device's raw log text.
export function parseLogText(fullText, unitId) {
  const marks = collectTimeMarks(fullText);
  resolveMarkDates(marks);
  const anchors = marks.filter((m) => m.isAnchor);

  const blocks = [];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    // A block's body runs to the next anchor, so intervening info lines stay part of it.
    const bodyEnd = i + 1 < anchors.length ? anchors[i + 1].index : fullText.length;
    const body = fullText.slice(anchor.bodyStart, bodyEnd);

    if (anchor.invalidClock) continue; // logged while the device's RTC was unset
    if (!anchor.date) continue; // no dated log line anywhere in this fetch — can't date it

    const { day, monStr, year } = anchor.date;
    const timestamp = toIsoTimestamp(anchor.time, anchor.offset, day, monStr, year);
    if (!timestamp) continue;

    const base = {
      unitId,
      timestamp,
      date: `${day}-${monStr}-${year}`,
      time: anchor.time,
      unitBatteryMv: anchor.batteryMv,
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
