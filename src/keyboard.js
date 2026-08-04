// Builds the inline menu. Level defaults to 'dev' so existing callers keep the full menu.
// Client trims raw-discovery buttons to a single "Latest Count" headline, keeps
// 1d/3d summaries (drops 7d), and swaps the battery chart for a text status list.
export function buildInlineKeyboard(subscribed, level = 'dev') {
  const rows = [[{ text: '🏷 Latest Count', callback_data: 'latest_count' }]];

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
  rows.push([
    { text: '🛰 GPS Status Map', callback_data: 'position_map' },
    { text: '🔥 Heatmap', callback_data: 'heatmap_default' },
  ]);

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
