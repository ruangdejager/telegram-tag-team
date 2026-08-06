import { appConfig } from './config.js';

// A tag is "missing" if it was seen inside the live window (default 72h) but hasn't
// been seen in the recent-threshold window (default 8h). This gives an early-warning
// signal that a tag we know exists on the farm has fallen off the network — likely
// low battery or out of range — without noise from tags that were never here.
export function findMissingTags(sessions, now = new Date(), {
  windowHours = appConfig.liveWindowHours,
  thresholdHours = appConfig.missingThresholdHours,
} = {}) {
  const nowMs = now.getTime();
  const windowStart = nowMs - windowHours * 60 * 60 * 1000;
  const thresholdStart = nowMs - thresholdHours * 60 * 60 * 1000;

  const lastSeenById = new Map();
  for (const session of sessions) {
    const t = new Date(session.timestamp).getTime();
    if (t < windowStart) continue;
    for (const tag of session.tags) {
      const prev = lastSeenById.get(tag.id);
      if (!prev || t > prev.timestampMs) {
        lastSeenById.set(tag.id, { timestampMs: t, date: session.date, time: session.time });
      }
    }
  }

  const missing = [];
  for (const [id, last] of lastSeenById.entries()) {
    if (last.timestampMs < thresholdStart) {
      missing.push({ id, lastSeen: last, hoursSince: (nowMs - last.timestampMs) / (60 * 60 * 1000) });
    }
  }
  missing.sort((a, b) => a.hoursSince - b.hoursSince); // most-recently-seen first (nearest to threshold)
  return missing;
}

// Formats an hour count as "Nd" when it's an exact multiple of a day, else "Nh".
function formatWindow(hours) {
  return hours % 24 === 0 ? `${hours / 24}d` : `${hours}h`;
}

export function formatMissingTags(missing, { thresholdHours = appConfig.missingThresholdHours, windowHours = appConfig.liveWindowHours } = {}) {
  const windowLabel = formatWindow(windowHours);
  if (missing.length === 0) {
    return `✅ <b>No missing tags.</b>\nAll tags seen in the last ${windowLabel} have also been seen in the last ${thresholdHours}h.`;
  }
  const rows = missing.map((m) => {
    const h = m.hoursSince;
    const ago = h < 24 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(1)}d ago`;
    return `${m.id}  —  ${m.lastSeen.date} ${m.lastSeen.time} (${ago})`;
  });
  return `🔍 <b>Missing Tags</b> (${missing.length})\n` +
    `<i>Seen in last ${windowLabel}, but not in last ${thresholdHours}h</i>\n\n` +
    `<pre>${rows.join('\n')}</pre>`;
}

// Compact list for appending inline at the end of a raw-discovery view.
export function formatMissingTagsInline(missing, { thresholdHours = appConfig.missingThresholdHours } = {}) {
  if (missing.length === 0) return '';
  const ids = missing.map((m) => m.id).sort().join(' ');
  return `\n<i>⚠️ Missing (not seen in last ${thresholdHours}h): ${ids}</i>`;
}
