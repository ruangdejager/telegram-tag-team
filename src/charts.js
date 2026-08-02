import { renderPlotly } from './plotlyRenderer.js';
import { sendPhotoOrError } from './telegramSend.js';
import { epochToJhb } from './utils.js';

const LINE_COLOURS = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];

// Battery-status thresholds shared with formatter.js's client view.
const CRITICAL_MV = 3450;
const WARNING_MV = 3650;
function batteryColor(mv) {
  if (mv < CRITICAL_MV) return '#e74c3c';
  if (mv < WARNING_MV) return '#f39c12';
  return '#2ecc71';
}

// Full-fleet snapshot: one horizontal bar per tag, latest reading, sorted worst
// to best. Height scales with tag count so every ID gets its own readable row.
export async function sendBatteryChart(bot, chatId, series, subscribed, level = 'dev') {
  const tags = Object.keys(series).map((id) => {
    const readings = series[id];
    const latest = readings[readings.length - 1].battery;
    return { id, latest, colour: batteryColor(latest) };
  });
  tags.sort((a, b) => a.latest - b.latest);

  if (tags.length === 0) {
    await sendPhotoOrError(bot, chatId, subscribed, null, '⚠️ No battery data yet.', { level });
    return;
  }

  const maxMv = Math.max(4100, ...tags.map((t) => t.latest));
  const figure = {
    data: [{
      type: 'bar',
      orientation: 'h',
      x: tags.map((t) => t.latest),
      y: tags.map((t) => t.id),
      marker: { color: tags.map((t) => t.colour) },
      hovertemplate: '%{y}: %{x} mV<extra></extra>',
    }],
    layout: {
      title: { text: `Tag Battery Levels (${tags.length})`, font: { size: 16 } },
      xaxis: { title: 'mV', range: [3200, maxMv], zeroline: false },
      yaxis: { automargin: true, tickfont: { size: 11 } },
      margin: { l: 60, r: 30, t: 60, b: 50 },
      showlegend: false,
      plot_bgcolor: 'white',
      paper_bgcolor: 'white',
    },
  };

  // Rows are ~24px tall; keep a minimum height for legibility even with few tags.
  const height = Math.max(440, 60 + tags.length * 24);
  const png = await renderPlotly(figure, { width: 800, height });
  await sendPhotoOrError(bot, chatId, subscribed, png, '📈 Battery levels — sorted worst to best', { level, filename: 'battery.png' });
}

// Battery-over-time line plot for one or more specific tags, over the given window.
// Readings are time-bucketed (keeping the latest reading per bucket) so the point
// count stays bounded regardless of how often a tag actually reports.
export async function sendBatteryTrendChart(bot, chatId, series, subscribed, tagIds, { windowDays = 7, maxPoints = 120, level = 'dev' } = {}) {
  const nowMs = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  const cutoffMs = nowMs - windowMs;
  const bucketMs = Math.max(15 * 60 * 1000, Math.ceil(windowMs / maxPoints));

  const perTagBuckets = {}; // id -> Map(bucketEpoch -> battery)
  const bucketSet = new Set();
  for (const id of tagIds) {
    const readings = (series[id] || []).filter((r) => new Date(r.sortKey).getTime() >= cutoffMs);
    const buckets = new Map();
    for (const r of readings) {
      const t = new Date(r.sortKey).getTime();
      const bucketEpoch = Math.floor(t / bucketMs) * bucketMs;
      const existing = buckets.get(bucketEpoch);
      if (!existing || t > existing.t) buckets.set(bucketEpoch, { t, battery: r.battery });
      bucketSet.add(bucketEpoch);
    }
    perTagBuckets[id] = buckets;
  }

  const bucketEpochs = [...bucketSet].sort((a, b) => a - b);
  if (bucketEpochs.length === 0) {
    await sendPhotoOrError(bot, chatId, subscribed, null, `⚠️ No battery data for <b>${tagIds.join(', ')}</b> in the last ${windowDays} days.`, { level });
    return;
  }

  const labels = bucketEpochs.map((epoch) => {
    const { date, time } = epochToJhb(epoch);
    const [day, mon] = date.split('-');
    return `${day}-${mon} ${time.slice(0, 5)}`;
  });

  const traces = tagIds.map((id, i) => {
    const buckets = perTagBuckets[id];
    return {
      type: 'scatter',
      mode: 'lines',
      name: id,
      x: labels,
      y: bucketEpochs.map((epoch) => (buckets.has(epoch) ? buckets.get(epoch).battery : null)),
      connectgaps: true,
      line: { color: LINE_COLOURS[i % LINE_COLOURS.length], width: 1.5, shape: 'spline', smoothing: 0.4 },
      hovertemplate: `${id}: %{y} mV<br>%{x}<extra></extra>`,
    };
  });

  const figure = {
    data: traces,
    layout: {
      title: { text: `Battery Trend — last ${windowDays}d`, font: { size: 16 } },
      yaxis: { title: 'mV' },
      xaxis: { tickangle: -45, nticks: 16, automargin: true },
      showlegend: tagIds.length > 1,
      legend: { orientation: 'h', y: -0.25 },
      margin: { l: 60, r: 20, t: 60, b: 100 },
      plot_bgcolor: 'white',
      paper_bgcolor: 'white',
    },
  };

  const png = await renderPlotly(figure, { width: 900, height: 500 });
  await sendPhotoOrError(bot, chatId, subscribed, png, `📉 Battery trend (${windowDays}d) — ${tagIds.join(', ')}`, { level, filename: 'battery-trend.png' });
}
