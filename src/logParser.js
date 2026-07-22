// Parses raw Farmranger unit log text into discovery blocks.
//
// Block header example:
//   *00:00:29(+02:00) Mon 06-Jul-2026 4019mV
//   ---------------------------------
//   Tag Discovery:
//
//   3194,1,-85,4055,1,1,0,0
//   ...
//
//   Total devices discovered: 9
//   ---------------------------------
//
// Tag record fields: id,hops,rssi,battery,waveCount,movementState,lat*1e6,lon*1e6[,fwVersionPatch]
// The trailing fwVersionPatch field is optional — older/some records omit it entirely
// (8 fields instead of 9), which is treated as "no fw version reported".
// A block may instead contain "LOG TIMEOUT" somewhere in its body, indicating the
// device failed to log a discovery round. Such blocks must be discarded entirely.

import { MONTHS } from './utils.js';

const HEADER_RE = /\*(\d{2}:\d{2}:\d{2})\(([+-]\d{2}:\d{2})\)\s+\w+\s+(\d{2})-(\w{3})-(\d{4})\s+(\d+)mV/g;

function toIsoTimestamp(time, offset, day, monStr, year) {
  const month = MONTHS[monStr];
  if (!month) return null;
  return `${year}-${month}-${day}T${time}${offset}`;
}

function parseTagLine(line) {
  const parts = line.split(',').map((p) => p.trim());
  if (parts.length !== 8 && parts.length !== 9) return null;
  const [id, hops, rssi, battery, waveCount, movementState, latRaw, lonRaw, fwRaw] = parts;

  const hopsNum = parseInt(hops, 10);
  const rssiNum = parseInt(rssi, 10);
  const batteryNum = parseInt(battery, 10);
  const waveCountNum = parseInt(waveCount, 10);
  const movementStateNum = parseInt(movementState, 10);
  const lat = parseInt(latRaw, 10);
  const lon = parseInt(lonRaw, 10);
  // Rejects non-tag rows that happen to have the right field count, e.g. the
  // 'DeviceId,Hops,RSSI,...' CSV header line some blocks now include under
  // "Tag Discovery:" — its numeric columns won't parse as numbers.
  if ([hopsNum, rssiNum, batteryNum, waveCountNum, movementStateNum, lat, lon].some(Number.isNaN)) return null;

  const fwVersionPatch = fwRaw !== undefined ? parseInt(fwRaw, 10) : NaN;
  return {
    id: id.toUpperCase(),
    hops: hopsNum,
    rssi: rssiNum,
    battery: batteryNum,
    waveCount: waveCountNum,
    movementState: movementStateNum,
    lat: lat === 0 ? null : lat / 1e6,
    lon: lon === 0 ? null : lon / 1e6,
    hasGps: !(lat === 0 && lon === 0),
    fwVersionPatch: Number.isNaN(fwVersionPatch) ? null : fwVersionPatch,
  };
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

    const tagSectionMatch = body.match(/Tag Discovery:([\s\S]*?)Total devices discovered:/i);
    const tags = [];
    if (tagSectionMatch) {
      tagSectionMatch[1].split(/\r?\n/).forEach((line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        const tag = parseTagLine(trimmed);
        if (tag) tags.push(tag);
      });
    }

    blocks.push({ ...base, isTimeout: false, tags, total });
  }

  return blocks;
}
