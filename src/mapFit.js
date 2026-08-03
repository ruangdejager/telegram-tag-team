// Given a set of GPS points and an output image size in pixels, compute the
// { centerLat, centerLon, zoom } Mapbox tile-zoom needed to fit the bounding
// box of those points into `fill` fraction (e.g. 0.8 = 80%) of the image
// surface. Both the Mapbox Static Images position map and the Plotly
// densitymapbox heatmap use this so their scale is a function of the point
// spread, not the point count.
//
// Math background: Web Mercator's x (longitude) is exactly linear in degrees —
// pixels-per-degree-longitude = worldSize/360 everywhere, no latitude term. Only
// y (latitude) picks up a local secant(φ) stretch factor (Mercator is conformal,
// so the projection's local scale is isotropic at a point, but longitude's global
// linearity means the cos φ term shows up on the latitude axis, not longitude —
// this is the reverse of what a first guess suggests, and got these two swapped
// in an earlier version, which shifted the fit off just enough to look "not quite
// centered" once padding was added around it):
//   pixels-per-degree-longitude(z)        = 256·2^z / 360
//   pixels-per-degree-latitude(z, φ, local) = 256·2^z / 360 · sec(φ)
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

  const zLon = Math.log2((fill * width * 360) / (256 * lonSpan));
  const zLat = Math.log2((fill * height * 360 * cosPhi) / (256 * latSpan));
  const zoom = Math.max(0, Math.min(zLat, zLon, 20));

  return { centerLat, centerLon, zoom };
}
