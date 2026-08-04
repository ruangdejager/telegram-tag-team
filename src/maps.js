import { appConfig } from './config.js';
import { renderPlotly } from './plotlyRenderer.js';
import { sendPhotoOrError } from './telegramSend.js';
import { findAllLatestGps } from './tagGps.js';
import { buildInlineKeyboard } from './keyboard.js';
import { fitBoundsToZoom } from './mapFit.js';

// Age-of-last-fix → pin colour. Chosen from the "colored pin" set Mapbox Static
// Images supports (hex allowed). Grey = no GPS fix at all (listed off-map in caption).
const HOUR_MS = 60 * 60 * 1000;
const AGE_BUCKETS = [
  { maxAgeMs: 2 * HOUR_MS, colour: '2ecc71', emoji: '🟢', ageText: '≤2h' },
  { maxAgeMs: 12 * HOUR_MS, colour: 'f1c40f', emoji: '🟡', ageText: '≤12h' },
  { maxAgeMs: 24 * HOUR_MS, colour: 'e67e22', emoji: '🟠', ageText: '≤24h' },
];
const OLD_COLOUR = 'e74c3c'; // 🔴 older than 24h
const OLD_EMOJI = '🔴';
const OLD_AGE_TEXT = '>24h';

// Fit target: bounding box of the plotted points should occupy this fraction of
// the image surface. Same for map and heatmap so their "spatial feel" agrees.
// Lower value → more surrounding context (roads/landmarks) visible around the pins;
// higher value → tighter crop. 0.55 leaves ~22% padding each side, comfortably more
// generous than Mapbox's /auto/ default so pins never crowd the frame edges.
const MAP_FILL = 0.55;
const MAP_WIDTH = 1000;
const MAP_HEIGHT = 800;
const HEATMAP_WIDTH = 900;
const HEATMAP_HEIGHT = 700;

function ageColour(ageMs) {
  for (const b of AGE_BUCKETS) if (ageMs < b.maxAgeMs) return b.colour;
  return OLD_COLOUR;
}

function ageLabel(ageMs) {
  const bucket = AGE_BUCKETS.find((b) => ageMs < b.maxAgeMs);
  return bucket ? `${bucket.emoji} ${bucket.ageText}` : `${OLD_EMOJI} ${OLD_AGE_TEXT}`;
}

// Mapbox "pin-s" markers anchor at their bottom tip, not their center, and the
// pin graphic (~30px tall at the logical/pre-@2x size we compute zoom against)
// extends upward from that tip. A tight cluster of pins therefore reads as
// visually shifted toward the top of the frame even though their true
// coordinates are exactly centered — the coordinate is centered, but the ink
// isn't. Compensate by requesting a viewport centered slightly north of the
// true coordinate centroid, by half a pin-height's worth of degrees at the
// computed zoom, so the pin bodies' upward extension lands in that headroom
// and the visible marker cluster balances out.
const PIN_HEIGHT_PX = 30;
function compensateForPinAnchor({ centerLat, zoom }) {
  const cosPhi = Math.cos((centerLat * Math.PI) / 180) || 1e-6;
  const degPerPixelLat = (360 * cosPhi) / (256 * 2 ** zoom);
  return centerLat + (PIN_HEIGHT_PX / 2) * degPerPixelLat;
}

async function replyNoMapbox(bot, chatId, subscribed, level) {
  await bot.sendMessage(chatId, '⚠️ Map features are not configured. Ask the operator to set <code>MAPBOX_TOKEN</code>.', {
    parse_mode: 'HTML',
    reply_markup: buildInlineKeyboard(subscribed, level),
  });
}

// Renders a Mapbox Static Images URL with one small coloured pin per GPS-fixed tag.
// Uses an explicit center+zoom fitted to the bounding box (not Mapbox's default
// /auto/), so a wider spread of points zooms out but adding more points inside
// the same bounding box doesn't — the scale reflects geography, not count.
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

  const pins = withGps.map((e) => `pin-s+${ageColour(now - e.timestampMs)}(${e.lon.toFixed(6)},${e.lat.toFixed(6)})`);
  const overlay = pins.join(','); // Mapbox URL cap is ~8k chars; ~40 chars/pin means we're safe up to ~200 tags.

  const fit = fitBoundsToZoom(withGps, { width: MAP_WIDTH, height: MAP_HEIGHT, fill: MAP_FILL });
  const viewportCenterLat = compensateForPinAnchor(fit);
  // Explicit bearing=0, pitch=0 — Mapbox's static-image viewport segment accepts
  // {lon},{lat},{zoom}[,{bearing},{pitch}]; being explicit rules out any parsing
  // ambiguity from the shorter 3-value form as a possible cause of mis-centering.
  const viewport = `${fit.centerLon.toFixed(6)},${viewportCenterLat.toFixed(6)},${fit.zoom.toFixed(2)},0,0`;
  const url = `https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/static/${overlay}/${viewport}/${MAP_WIDTH}x${MAP_HEIGHT}@2x?access_token=${appConfig.mapboxToken}`;
  console.log(`[map] fit=${JSON.stringify(fit)} viewport=${viewport} pins=${withGps.length}`);
  console.log(`[map] url=${url}`);

  const bucketCounts = AGE_BUCKETS.map(() => 0);
  let oldCount = 0;
  for (const e of withGps) {
    const ms = now - e.timestampMs;
    const idx = AGE_BUCKETS.findIndex((b) => ms < b.maxAgeMs);
    if (idx === -1) oldCount++;
    else bucketCounts[idx]++;
  }
  // Telegram parses '<' as an HTML tag opener even inside body text, so use the
  // Unicode less-than-or-equal glyph instead of a literal '<'.
  const legend = AGE_BUCKETS.map((b, i) => `${b.emoji} ${bucketCounts[i]} ${b.ageText}`).join(' · ') +
    ` · ${OLD_EMOJI} ${oldCount} older`;
  const caption =
    `🛰 <b>Last known positions</b> (${withGps.length} tag${withGps.length !== 1 ? 's' : ''})\n` +
    legend +
    (noGps.length ? `\n<i>No GPS fix ever:</i> ${noGps.join(', ')}` : '');

  await sendPhotoOrError(bot, chatId, subscribed, url, caption, { level });
}

// A single tag's most-recent-fix age classification, so the caption on a legend
// or per-tag hover can be built if needed.
export { ageLabel };

// Density colorscale that starts near-transparent so a lone point renders as a
// faint mark rather than a fully saturated blob. Densely-clustered points sum
// to higher z within Plotly's kernel and get closer to the dark-red end.
const HEATMAP_COLORSCALE = [
  [0.0, 'rgba(255,255,178,0.00)'], // fully transparent — no data
  [0.05, 'rgba(255,255,178,0.35)'], // very light yellow — single/isolated readings
  [0.25, 'rgba(254,204,92,0.65)'],  // gold — a few overlapping readings
  [0.55, 'rgba(253,141,60,0.80)'],  // orange — a real cluster
  [0.85, 'rgba(240,59,32,0.90)'],   // red — hotspot
  [1.0, 'rgba(189,0,38,1.00)'],     // dark red — max concentration
];

// Fixed density scale: 1 = a lone reading, ~8+ = full saturation. Chosen so a
// single point stays near the light end of the colorscale (see the [0.05] stop
// above), matching the "single point should be much lighter" spec.
const HEATMAP_ZMIN = 0;
const HEATMAP_ZMAX = 8;

// Spatial density heatmap over the given date range, using Plotly's densitymapbox
// with a Mapbox satellite basemap. Uses every GPS reading in the range (not just
// per-tag latest) so a tag that stayed on one spot for hours shows up denser
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

  const points = lats.map((lat, i) => ({ lat, lon: lons[i] }));
  const fit = fitBoundsToZoom(points, { width: HEATMAP_WIDTH, height: HEATMAP_HEIGHT, fill: MAP_FILL });

  const figure = {
    data: [{
      type: 'densitymapbox',
      lat: lats,
      lon: lons,
      z: lats.map(() => 1), // equal-weight; density comes from summed kernels at each cell
      radius: 18,           // narrower kernel so isolated points stay visibly isolated
      zmin: HEATMAP_ZMIN,
      zmax: HEATMAP_ZMAX,
      colorscale: HEATMAP_COLORSCALE,
      showscale: true,
      colorbar: { title: { text: 'density' } },
      hovertemplate: 'lat %{lat:.5f}, lon %{lon:.5f}<extra></extra>',
    }],
    layout: {
      title: { text: `🔥 Tag density — ${label}`, font: { size: 16 } },
      mapbox: {
        style: 'satellite-streets',
        accesstoken: appConfig.mapboxToken,
        center: { lat: fit.centerLat, lon: fit.centerLon },
        zoom: fit.zoom,
      },
      margin: { l: 0, r: 0, t: 40, b: 0 },
    },
  };

  const png = await renderPlotly(figure, { width: HEATMAP_WIDTH, height: HEATMAP_HEIGHT });
  const caption = `🔥 <b>Tag density heatmap</b> (${label}) — ${lats.length} GPS reading${lats.length !== 1 ? 's' : ''}`;
  await sendPhotoOrError(bot, chatId, subscribed, png, caption, { level, filename: 'heatmap.png' });
}
