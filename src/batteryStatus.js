// Battery status thresholds and colours, shared by the dev raw-discovery table
// (formatter.js) and the fleet-snapshot chart (charts.js) so they always agree.
// Client raw-discovery uses its own simpler 3-colour scheme in formatter.js.

// Thresholds (mV), applied worst-case-wins:
//   ≥ 3800       → green   (healthy)
//   3600 – 3800  → blue    (working range)
//   3500 – 3600  → orange  (low, watch)
//   < 3500       → red     (critical)
export const BATT_GREEN_MIN = 3800;
export const BATT_BLUE_MIN = 3600;
export const BATT_ORANGE_MIN = 3500;

// Hex colours for the chart bars (no leading '#'; Plotly/Mapbox both accept with #).
export const BATT_COLOUR_HEX = {
  green: '#2ecc71',
  blue: '#3498db',
  orange: '#e67e22',
  red: '#e74c3c',
  unknown: '#95a5a6',
};

// Emoji dot for the dev raw-discovery status column.
export const BATT_COLOUR_EMOJI = {
  green: '🟢',
  blue: '🔵',
  orange: '🟠',
  red: '🔴',
  unknown: '⚪',
};

// User-facing legend for the 4-colour scheme. "(gps not allowed)" is explanatory
// text only (low-battery tags typically stop transmitting GPS) — it does not
// gate or block GPS query behavior anywhere.
export const BATTERY_LEGEND_TEXT = '🟢 Fully charged · 🔵 Good · 🟠 watch · 🔴 low battery (gps not allowed)';

export function batteryBucket(mv) {
  if (mv === null || mv === undefined || Number.isNaN(mv)) return 'unknown';
  if (mv >= BATT_GREEN_MIN) return 'green';
  if (mv >= BATT_BLUE_MIN) return 'blue';
  if (mv >= BATT_ORANGE_MIN) return 'orange';
  return 'red';
}

export function batteryColorHex(mv) {
  return BATT_COLOUR_HEX[batteryBucket(mv)];
}

export function batteryEmoji(mv) {
  return BATT_COLOUR_EMOJI[batteryBucket(mv)];
}
