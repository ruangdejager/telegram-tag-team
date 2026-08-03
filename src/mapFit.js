// Given a set of GPS points and an output image size in pixels, compute the
// { centerLat, centerLon, zoom } Mapbox tile-zoom needed to fit the bounding
// box of those points into `fill` fraction (e.g. 0.8 = 80%) of the image
// surface. Both the Mapbox Static Images position map and the Plotly
// densitymapbox heatmap use this so their scale is a function of the point
// spread, not the point count.
//
// Math background: Mapbox/Web Mercator uses 256-px tiles doubling in count
// per zoom level, so:
//   deg-per-pixel of longitude at zoom z, latitude φ ≈ 360 / (256 · 2^z · cos φ)
//   deg-per-pixel of latitude  at zoom z              ≈ 360 / (256 · 2^z)
// Solving each for z (given target span in degrees ≤ fill · dimension pixels)
// then taking the smaller z fits both axes with the box at exactly `fill` of
// the tightest-constrained dimension.

export function fitBoundsToZoom(points, { width, height, fill = 0.8 } = {}) {
  if (points.length === 0) return null;
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
  }
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;

  // Guard against a single point or all-identical points — otherwise log2 blows up.
  // A degenerate span still gets a reasonable street-level zoom (18).
  const latSpan = Math.max(maxLat - minLat, 1e-6);
  const lonSpan = Math.max(maxLon - minLon, 1e-6);
  const cosPhi = Math.cos((centerLat * Math.PI) / 180) || 1e-6;

  const zLon = Math.log2((fill * width * 360) / (256 * lonSpan * cosPhi));
  const zLat = Math.log2((fill * height * 360) / (256 * latSpan));
  const zoom = Math.max(0, Math.min(zLat, zLon, 20));

  return { centerLat, centerLon, zoom };
}
