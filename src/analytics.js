// Builds a per-tag time series from merged sessions.
// Returns { tagId: [{ sortKey, date, time, battery, rssi, hops, waveCount, movementState }] }
export function buildTagSeries(sessions) {
  const series = {};
  sessions.forEach((session) => {
    session.tags.forEach((t) => {
      const id = t.id.toUpperCase();
      if (!series[id]) series[id] = [];
      series[id].push({
        sortKey: session.timestamp,
        date: session.date,
        time: session.time,
        battery: t.battery,
        rssi: t.rssi,
        hops: t.hops,
        waveCount: t.waveCount,
        movementState: t.movementState,
      });
    });
  });
  Object.values(series).forEach((readings) => readings.sort((a, b) => a.sortKey.localeCompare(b.sortKey)));
  return series;
}
