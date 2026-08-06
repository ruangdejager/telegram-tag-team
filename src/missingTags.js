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

// The "Missing List" feature: every tag seen within the window that WASN'T part of
// the most recent discovery round (`sessions` is assumed sorted ascending by time,
// as fetchHistorySessions returns it — the last entry is the latest round). Each
// entry is `flagged` if its last sighting was more than thresholdHours ago, so the
// list can highlight the ones that are actually a concern vs. tags that simply
// didn't show up in this one round but were seen recently.
export function findTagsMissingFromLatest(sessions, now = new Date(), {
  windowHours = appConfig.liveWindowHours,
  thresholdHours = appConfig.missingThresholdHours,
} = {}) {
  if (sessions.length === 0) return [];

  const nowMs = now.getTime();
  const windowStart = nowMs - windowHours * 60 * 60 * 1000;
  const thresholdStart = nowMs - thresholdHours * 60 * 60 * 1000;
  const latestIds = new Set(sessions[sessions.length - 1].tags.map((t) => t.id));

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
    if (latestIds.has(id)) continue;
    missing.push({
      id,
      lastSeen: last,
      hoursSince: (nowMs - last.timestampMs) / (60 * 60 * 1000),
      flagged: last.timestampMs < thresholdStart,
    });
  }
  missing.sort((a, b) => a.hoursSince - b.hoursSince); // most-recently-seen first
  return missing;
}

export function formatMissingTags(missing, { thresholdHours = appConfig.missingThresholdHours, windowHours = appConfig.liveWindowHours } = {}) {
  const windowLabel = formatWindow(windowHours);
  if (missing.length === 0) {
    return `✅ <b>No missing tags.</b>\nEvery tag seen in the last ${windowLabel} was part of the latest discovery.`;
  }
  const rows = missing.map((m) => {
    const h = m.hoursSince;
    const ago = h < 24 ? `${h.toFixed(1)}h ago` : `${(h / 24).toFixed(1)}d ago`;
    return `${m.flagged ? '🔴' : '  '} ${m.id}  —  ${m.lastSeen.date} ${m.lastSeen.time} (${ago})`;
  });
  return `🔍 <b>Missing Tags</b> (${missing.length})\n` +
    `<i>Not in the latest discovery, over last ${windowLabel} · 🔴 = not seen in last ${thresholdHours}h</i>\n\n` +
    `<pre>${rows.join('\n')}</pre>`;
}

// Compact list for appending inline at the end of a raw-discovery view.
export function formatMissingTagsInline(missing, { thresholdHours = appConfig.missingThresholdHours } = {}) {
  if (missing.length === 0) return '';
  const ids = missing.map((m) => m.id).sort().join(' ');
  return `\n<i>⚠️ Missing (not seen in last ${thresholdHours}h): ${ids}</i>`;
}
