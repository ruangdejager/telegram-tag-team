import { config } from './config.js';

// Farmranger API expects local Africa/Johannesburg wall-clock time (fixed UTC+2, no DST),
// same as the original Apps Script (TZ 'Africa/Johannesburg'). We must compute this
// explicitly rather than relying on the server's local clock, since Railway runs in UTC.
const JHB_OFFSET_MS = 2 * 60 * 60 * 1000;

function toJhbParts(d) {
  const shifted = new Date(d.getTime() + JHB_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hours: shifted.getUTCHours(),
    minutes: shifted.getUTCMinutes(),
  };
}

// Mirrors the old Apps Script buildApiUrl: from = start of day (or override), to = now.
export function buildApiUrl(unitId, now, fromOverride) {
  const from = fromOverride ?? startOfDay(now);
  return `${config.apiBase}${unitId}/logs?From=${toApiDate(from)}&To=${toApiDate(now)}`;
}

function startOfDay(d) {
  const { year, month, day } = toJhbParts(d);
  // Midnight Johannesburg time, expressed back as a UTC instant.
  return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - JHB_OFFSET_MS);
}

function toApiDate(d) {
  const { year, month, day, hours, minutes } = toJhbParts(d);
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}`;
}

export async function fetchUnitLogText(unitId, now = new Date(), fromOverride) {
  const url = buildApiUrl(unitId, now, fromOverride);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`API returned HTTP ${res.status} for unit ${unitId}: ${(await res.text()).slice(0, 200)}`);
  }
  const entries = await res.json();
  if (!Array.isArray(entries)) {
    throw new Error(`Unexpected API response for unit ${unitId} — expected a JSON array.`);
  }
  return entries.map((e) => e.logText || '').join('\n');
}
