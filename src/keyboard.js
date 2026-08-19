// Default screen: just "Latest Count" + "Menu" — tapping Menu reveals the full
// button list below. Kept minimal so most replies aren't cluttered with buttons
// the user doesn't need for a quick check.
export function buildSimpleKeyboard() {
  return {
    inline_keyboard: [
      [{ text: '🏷 Latest Count', callback_data: 'latest_count' }],
      [{ text: '📋 Menu', callback_data: 'menu' }],
    ],
  };
}

// Full menu. Level defaults to 'dev' so existing callers keep the full menu.
// Client trims raw-discovery buttons to a single "Latest Count" headline, keeps
// 1d/3d summaries (drops 7d), and swaps the battery chart for a text status list.
export function buildFullKeyboard(subscribed, level = 'dev') {
  const rows = [
    [{ text: '🏷 Latest Count', callback_data: 'latest_count' }],
    [{ text: '🕒 Count Window', callback_data: 'count_window_prompt' }],
  ];

  if (level === 'client') {
    rows.push([
      { text: '📊 1d Sum', callback_data: 'hist_1d' },
      { text: '📊 3d Sum', callback_data: 'hist_3d' },
    ]);
  } else {
    rows.push([
      { text: '📋 Latest', callback_data: 'hist_latest' },
      { text: '📋 Last 4h', callback_data: 'hist_4h' },
      { text: '📋 Last 24h', callback_data: 'hist_24h' },
    ]);
    rows.push([
      { text: '📊 1d Sum', callback_data: 'hist_1d' },
      { text: '📊 3d Sum', callback_data: 'hist_3d' },
      { text: '📊 7d Sum', callback_data: 'hist_7d' },
    ]);
  }

  rows.push([
    { text: '🔍 Missing List', callback_data: 'missing_tags' },
    { text: '📍 GPS Query', callback_data: 'gps_prompt' },
  ]);
  // Map / heatmap views are dev-only — the client audience doesn't need the
  // spatial detail and keeping the client keyboard shorter matches the
  // "simplified view" philosophy for that level.
  if (level !== 'client') {
    rows.push([
      { text: '🛰 GPS Status Map', callback_data: 'position_map' },
      { text: '🎯 Latest Positions', callback_data: 'latest_positions_map' },
    ]);
    rows.push([{ text: '🔥 Heatmap', callback_data: 'heatmap_default' }]);
  }

  if (level === 'client') {
    rows.push([{ text: '🔋 Battery Status List', callback_data: 'analytics_batt_list' }]);
  } else {
    rows.push([
      { text: '🔋 Battery Level List', callback_data: 'analytics_batt_chart' },
      { text: '📉 Trend', callback_data: 'batt_trend_prompt' },
    ]);
  }

  rows.push([
    subscribed
      ? { text: '❌ Opt Out', callback_data: 'optout' }
      : { text: '✅ Opt In for live updates', callback_data: 'optin' },
  ]);

  return { inline_keyboard: rows };
}
