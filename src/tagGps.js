// Finds the most recent GPS-tagged reading of a specific tag ID across the given sessions,
// returning { lat, lon, date, time } or null if that tag has never had a GPS fix in the range.
export function findLatestGpsForTag(sessions, tagId) {
  const target = tagId.toUpperCase();
  let best = null;
  for (const session of sessions) {
    for (const tag of session.tags) {
      if (tag.id !== target || !tag.hasGps) continue;
      const t = new Date(session.timestamp).getTime();
      if (!best || t > best.timestampMs) {
        best = { lat: tag.lat, lon: tag.lon, date: session.date, time: session.time, timestampMs: t };
      }
    }
  }
  return best;
}

// Also returns whether the tag was seen at all (even without GPS), so we can distinguish
// "unknown tag" from "known tag but never reported GPS".
export function findTagLastSeen(sessions, tagId) {
  const target = tagId.toUpperCase();
  let best = null;
  for (const session of sessions) {
    for (const tag of session.tags) {
      if (tag.id !== target) continue;
      const t = new Date(session.timestamp).getTime();
      if (!best || t > best.timestampMs) {
        best = { date: session.date, time: session.time, timestampMs: t };
      }
    }
  }
  return best;
}

export function formatTagGps(tagId, gps, seen) {
  const target = tagId.toUpperCase();
  if (!seen) {
    return `❓ Tag <b>${target}</b> hasn't been seen in the queried range.`;
  }
  if (!gps) {
    return `📍 Tag <b>${target}</b> was last seen ${seen.date} ${seen.time}, but has never reported a GPS fix.`;
  }
  const url = `https://www.google.com/maps/search/?api=1&query=${gps.lat},${gps.lon}`;
  return (
    `📍 <b>${target}</b> last known GPS\n` +
    `<b>${gps.lat.toFixed(6)}, ${gps.lon.toFixed(6)}</b>\n` +
    `<i>Fix taken: ${gps.date} ${gps.time}</i>\n` +
    `<a href="${url}">Open in Google Maps</a>`
  );
}
