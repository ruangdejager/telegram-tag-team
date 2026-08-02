import { appConfig } from './config.js';
import { renderPlotly } from './plotlyRenderer.js';
import { sendPhotoOrError } from './telegramSend.js';
import { findAllLatestGps } from './tagGps.js';
import { buildInlineKeyboard } from './keyboard.js';

// Age-of-last-fix → pin colour. Chosen from the "colored pin" set Mapbox Static
// Images supports (hex allowed). Grey = no GPS fix at all (listed off-map in caption).
const HOUR_MS = 60 * 60 * 1000;
const AGE_BUCKETS = [
  { maxAgeMs: 2 * HOUR_MS, colour: '2ecc71', label: '🟢 ≤2h' },
  { maxAgeMs: 24 * HOUR_MS, colour: 'f1c40f', label: '🟡 ≤24h' },
  { maxAgeMs: 3 * 24 * HOUR_MS, colour: 'e67e22', label: '🟠 ≤3d' },
];
const OLD_COLOUR = 'e74c3c'; // 🔴 3d+

function ageColour(ageMs) {
  for (const b of AGE_BUCKETS) if (ageMs < b.maxAgeMs) return b.colour;
  return OLD_COLOUR;
}

function ageLabel(ageMs) {
  if (ageMs < AGE_BUCKETS[0].maxAgeMs) return AGE_BUCKETS[0].label;
  if (ageMs < AGE_BUCKETS[1].maxAgeMs) return AGE_BUCKETS[1].label;
  if (ageMs < AGE_BUCKETS[2].maxAgeMs) return AGE_BUCKETS[2].label;
  return '🔴 >3d';
}

async function replyNoMapbox(bot, chatId, subscribed, level) {
  await bot.sendMessage(chatId, '⚠️ Map features are not configured. Ask the operator to set <code>MAPBOX_TOKEN</code>.', {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(subscribed, level),
  });
}

// Renders a Mapbox Static Images URL with one small coloured pin per GPS-fixed tag.
// The Static Images API auto-fits the viewport to the pins when we use `auto/` and
// draws them all in a single GET request — no server-side compositing needed.
export async function sendPositionMap(bot, chatId, subscribed, sessions, level = 'dev') {
  if (!appConfig.mapboxToken) return replyNoMapbox(bot, chatId, subscribed, level);

  const now = Date.now();
  const entries = findAllLatestGps(sessions);
  const withGps = entries.filter((e) => e.hasGps);
  const noGps = entries.filter((e) => !e.hasGps).map((e) => e.id).sort();

  if (withGps.length === 0) {
    await sendPhotoOrError(bot, chatId, subscribed, null,
      '⚠️ No tags have ever reported a GPS fix.' + (noGps.length ? `\n<i>Ever seen without GPS:</i> ${noGps.join(', ')}` : ''),
      { level });
    return;
  }

  // Colour by fix age. Same tag never appears twice (findAllLatestGps returns one entry per id).
  const pins = withGps.map((e) => `pin-s+${ageColour(now - e.timestampMs)}(${e.lon.toFixed(6)},${e.lat.toFixed(6)})`);
  // Mapbox URL cap is ~8k chars; ~40 chars/pin means we're safe up to ~200 tags.
  const overlay = pins.join(',');
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${overlay}/auto/1000x800@2x?access_token=${appConfig.mapboxToken}`;

  const counts = { g: 0, y: 0, o: 0, r: 0 };
  for (const e of withGps) {
    const ms = now - e.timestampMs;
    if (ms < AGE_BUCKETS[0].maxAgeMs) counts.g++;
    else if (ms < AGE_BUCKETS[1].maxAgeMs) counts.y++;
    else if (ms < AGE_BUCKETS[2].maxAgeMs) counts.o++;
    else counts.r++;
  }
  // Telegram parses '<' as an HTML tag opener even inside body text, so use the
  // Unicode less-than-or-equal glyph instead of a literal '<'.
  const caption =
    `🛰 <b>Last known positions</b> (${withGps.length} tag${withGps.length !== 1 ? 's' : ''})\n` +
    `🟢 ${counts.g} ≤2h · 🟡 ${counts.y} ≤24h · 🟠 ${counts.o} ≤3d · 🔴 ${counts.r} older` +
    (noGps.length ? `\n<i>No GPS fix ever:</i> ${noGps.join(', ')}` : '');

  await sendPhotoOrError(bot, chatId, subscribed, url, caption, { level });
}

// A single tag's most-recent-fix age classification, so the caption on a legend
// or per-tag hover can be built if needed.
export { ageLabel };

// Spatial density heatmap over the given date range, using Plotly's densitymapbox
// with a Mapbox satellite basemap. Uses every GPS reading in the range (not just
// per-tag latest), so a tag that stayed on one spot for hours shows up denser
// there than a tag that only appeared once — which is exactly the point.
export async function sendHeatmap(bot, chatId, subscribed, sessions, { fromMs, toMs, label, level = 'dev' } = {}) {
  if (!appConfig.mapboxToken) return replyNoMapbox(bot, chatId, subscribed, level);

  const lats = [];
  const lons = [];
  for (const s of sessions) {
    const t = new Date(s.timestamp).getTime();
    if (t < fromMs || t > toMs) continue;
    for (const tag of s.tags) {
      if (!tag.hasGps) continue;
      lats.push(tag.lat);
      lons.push(tag.lon);
    }
  }

  if (lats.length === 0) {
    await sendPhotoOrError(bot, chatId, subscribed, null, `⚠️ No GPS readings in the ${label} range to build a heatmap.`, { level });
    return;
  }

  // Auto-center on the mean position; densitymapbox handles zoom via its own layout.
  const meanLat = lats.reduce((a, b) => a + b, 0) / lats.length;
  const meanLon = lons.reduce((a, b) => a + b, 0) / lons.length;
  // Zoom heuristic: tight cluster (typical farm) is ~15, spread out drops to ~13.
  const latRange = Math.max(...lats) - Math.min(...lats);
  const lonRange = Math.max(...lons) - Math.min(...lons);
  const spread = Math.max(latRange, lonRange);
  const zoom = spread < 0.005 ? 16 : spread < 0.02 ? 15 : spread < 0.05 ? 14 : spread < 0.2 ? 12 : 10;

  const figure = {
    data: [{
      type: 'densitymapbox',
      lat: lats,
      lon: lons,
      z: lats.map(() => 1), // equal-weight — density is measured by point count per cell
      radius: 25,
      colorscale: 'YlOrRd',
      showscale: true,
      colorbar: { title: 'density' },
      hovertemplate: 'lat %{lat:.5f}, lon %{lon:.5f}<extra></extra>',
    }],
    layout: {
      title: { text: `🔥 Tag density — ${label}`, font: { size: 16 } },
      mapbox: {
        style: 'satellite-streets',
        accesstoken: appConfig.mapboxToken,
        center: { lat: meanLat, lon: meanLon },
        zoom,
      },
      margin: { l: 0, r: 0, t: 40, b: 0 },
    },
  };

  const png = await renderPlotly(figure, { width: 900, height: 700 });
  const caption = `🔥 <b>Tag density heatmap</b> (${label}) — ${lats.length} GPS reading${lats.length !== 1 ? 's' : ''}`;
  await sendPhotoOrError(bot, chatId, subscribed, png, caption, { level, filename: 'heatmap.png' });
}
