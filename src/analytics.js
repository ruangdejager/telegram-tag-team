// Builds a per-tag time series from merged sessions.
// Returns { tagId: [{ sortKey, date, time, battery, rssi, hops, waveCount, movementState }] }
export function buildTagSeries(sessions) {
  const series = {};
  sessions.forEach((session) => {
    session.tags.forEach((t) => {
      // A near-zero reading (seen as low as 1mV, alongside impossible rssi/movementState
      // values in the same row) is corrupted log data, not a real measurement — a tag
      // can't be transmitting and reporting a dead battery at once. These come from
      // rows that got garbled in transit (same class as the concatenated-row bug), so
      // exclude anything below a real device's plausible operating range. Excluding it
      // here (rather than plotting it) keeps every downstream consumer (charts, "latest
      // battery" picks) clean without touching the raw discovery-table display, which
      // shows exactly what was logged.
      if (!Number.isFinite(t.battery) || t.battery < 1000) return;
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
