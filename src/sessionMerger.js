import { config } from './config.js';
import { epochToJhb } from './utils.js';

// Merges discovery blocks from one or more devices into "sessions": a single
// discovery round that may be split across multiple devices' logs — and, in
// practice, sometimes split into multiple blocks from the *same* device a few
// seconds apart (duplicate emission).
//
// Rather than chaining nearby timestamps, each block's timestamp is rounded to
// the nearest bracket (default every 15 minutes: 12:00, 12:15, 12:30, ...) and
// every block whose timestamp rounds to the same bracket — regardless of which
// device, or how many blocks a single device contributed — is combined into
// one session. This is safe because actual discovery rounds are hours apart,
// far wider than the bracket width.
//
// If any block in a bracket is a LOG TIMEOUT, the whole session is discarded
// (across all devices) and flagged so the caller can notify Telegram.
export function mergeSessions(blocksByUnit, bracketMinutes = config.mergeBracketMinutes) {
  const bracketMs = bracketMinutes * 60 * 1000;
  const all = Object.values(blocksByUnit).flat().filter((b) => b.timestamp);

  const buckets = new Map(); // bracketEpoch -> blocks[]
  for (const block of all) {
    const epoch = new Date(block.timestamp).getTime();
    const bracketEpoch = Math.round(epoch / bracketMs) * bracketMs;
    if (!buckets.has(bracketEpoch)) buckets.set(bracketEpoch, []);
    buckets.get(bracketEpoch).push(block);
  }

  return [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bracketEpoch, blocks]) => bucketToSession(bracketEpoch, blocks));
}

function bucketToSession(bracketEpoch, blocks) {
  const { date, time, iso } = epochToJhb(bracketEpoch);
  const timeoutBlocks = blocks.filter((b) => b.isTimeout);

  if (timeoutBlocks.length > 0) {
    return {
      timestamp: iso,
      discarded: true,
      timeoutUnitIds: [...new Set(timeoutBlocks.map((b) => b.unitId))],
      involvedUnitIds: [...new Set(blocks.map((b) => b.unitId))],
    };
  }

  const tagById = new Map();
  const perDeviceTagIds = {}; // unitId -> Set of tag IDs, deduped across that device's own blocks too
  for (const block of blocks) {
    if (!perDeviceTagIds[block.unitId]) perDeviceTagIds[block.unitId] = new Set();
    for (const tag of block.tags) {
      perDeviceTagIds[block.unitId].add(tag.id);
      const existing = tagById.get(tag.id);
      if (!existing) {
        tagById.set(tag.id, { ...tag, sourceUnitId: block.unitId });
      } else {
        // Per-scan readings (rssi/battery/etc.) keep whichever device saw the tag first —
        // but fw version and GPS are properties of the tag itself, so backfill them from
        // this block if the first-seen block didn't happen to report them.
        if (existing.fwVersionPatch === null && tag.fwVersionPatch !== null) {
          existing.fwVersionPatch = tag.fwVersionPatch;
        }
        if (!existing.hasGps && tag.hasGps) {
          existing.hasGps = true;
          existing.lat = tag.lat;
          existing.lon = tag.lon;
        }
      }
    }
  }

  const perDeviceTotals = {};
  for (const [unitId, ids] of Object.entries(perDeviceTagIds)) perDeviceTotals[unitId] = ids.size;

  return {
    timestamp: iso,
    date,
    time,
    discarded: false,
    involvedUnitIds: [...new Set(blocks.map((b) => b.unitId))],
    tags: [...tagById.values()],
    total: tagById.size,
    perDeviceTotals,
  };
}
