import { buildInlineKeyboard } from './keyboard.js';
import { epochToJhb } from './utils.js';

const LINE_COLOURS = ['#3498db', '#e74c3c', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e'];

async function createQuickChart(chartConfig, width = 800, height = 420) {
  const body = { chart: chartConfig, width, height, version: '3', backgroundColor: 'white' };
  const res = await fetch('https://quickchart.io/chart/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`QuickChart error: ${(await res.text()).slice(0, 200)}`);
  const result = await res.json();
  if (!result.success) throw new Error('QuickChart returned success:false');
  return result.url;
}

async function sendChartOrError(bot, chatId, subscribed, chartConfig, caption, { width = 800, height = 440 } = {}) {
  try {
    const url = await createQuickChart(chartConfig, width, height);
    await bot.sendPhoto(chatId, url, { caption, parse_mode: 'HTML', reply_markup: buildInlineKeyboard(subscribed) });
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Chart unavailable — try again in a moment.\n\n${err.message}`, {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard(subscribed),
    });
  }
}

// Full-fleet snapshot: one bar per tag, latest reading, sorted worst to best.
export async function sendBatteryChart(bot, chatId, series, subscribed) {
  const CRITICAL = 3400, WARNING = 3600;
  const tags = Object.keys(series).map((id) => {
    const readings = series[id];
    const latest = readings[readings.length - 1].battery;
    const colour = latest < CRITICAL ? '#e74c3c' : latest < WARNING ? '#f39c12' : '#2ecc71';
    return { id, latest, colour };
  });
  tags.sort((a, b) => a.latest - b.latest);

  const chartConfig = {
    type: 'bar',
    data: {
      labels: tags.map((t) => t.id),
      datasets: [{ label: 'Battery (mV)', data: tags.map((t) => t.latest), backgroundColor: tags.map((t) => t.colour) }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: { display: true, text: 'Tag Battery Levels', font: { size: 16 } },
      },
      scales: { y: { min: 3200, title: { display: true, text: 'mV' } }, x: { ticks: { maxRotation: 45 } } },
    },
  };

  await sendChartOrError(bot, chatId, subscribed, chartConfig, '📈 Battery levels — sorted worst to best');
}

// Battery-over-time line plot for one or more specific tags, over the given window.
// Readings are bucketed by time (keeping only the latest reading per bucket) so the
// point count stays bounded regardless of how often a tag actually reports — QuickChart's
// free tier rejects requests over a few hundred data points.
export async function sendBatteryTrendChart(bot, chatId, series, subscribed, tagIds, { windowDays = 7, maxPoints = 120 } = {}) {
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
    await bot.sendMessage(chatId, `⚠️ No battery data for <b>${tagIds.join(', ')}</b> in the last ${windowDays} days.`, {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard(subscribed),
    });
    return;
  }

  const labels = bucketEpochs.map((epoch) => {
    const { date, time } = epochToJhb(epoch);
    const [day, mon] = date.split('-');
    return `${day}-${mon} ${time.slice(0, 5)}`;
  });

  const datasets = tagIds.map((id, i) => {
    const buckets = perTagBuckets[id];
    const colour = LINE_COLOURS[i % LINE_COLOURS.length];
    return {
      label: id,
      data: bucketEpochs.map((epoch) => (buckets.has(epoch) ? buckets.get(epoch).battery : null)),
      spanGaps: true,
      borderColor: colour,
      backgroundColor: colour,
      fill: false,
      tension: 0.15,
    };
  });

  const chartConfig = {
    type: 'line',
    data: { labels, datasets },
    options: {
      plugins: {
        legend: { display: tagIds.length > 1 },
        title: { display: true, text: `Battery Trend — last ${windowDays}d`, font: { size: 16 } },
      },
      scales: { y: { title: { display: true, text: 'mV' } }, x: { ticks: { maxRotation: 60, autoSkip: true, maxTicksLimit: 16 } } },
    },
  };

  await sendChartOrError(bot, chatId, subscribed, chartConfig, `📉 Battery trend (${windowDays}d) — ${tagIds.join(', ')}`);
}
