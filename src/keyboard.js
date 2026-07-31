// Builds the inline menu. Client-level bots omit the technical Trend chart; every
// other button is shared. Level defaults to 'dev' so existing callers keep the full menu.
export function buildInlineKeyboard(subscribed, level = 'dev') {
  const rows = [
    [
      { text: '📋 Latest', callback_data: 'hist_latest' },
      { text: '📋 4h', callback_data: 'hist_4h' },
      { text: '📋 24h', callback_data: 'hist_24h' },
    ],
    [
      { text: '📊 1d', callback_data: 'hist_1d' },
      { text: '📊 3d', callback_data: 'hist_3d' },
      { text: '📊 7d', callback_data: 'hist_7d' },
    ],
    [
      { text: '🔍 Missing', callback_data: 'missing_tags' },
      { text: '📍 GPS', callback_data: 'gps_prompt' },
    ],
  ];

  if (level === 'client') {
    rows.push([{ text: '🔋 Battery', callback_data: 'analytics_batt_chart' }]);
  } else {
    rows.push([
      { text: '🔋 Battery', callback_data: 'analytics_batt_chart' },
      { text: '📉 Trend', callback_data: 'batt_trend_prompt' },
    ]);
  }

  rows.push([
    subscribed
      ? { text: '❌ Opt Out', callback_data: 'optout' }
      : { text: '✅ Opt In', callback_data: 'optin' },
  ]);

  return { inline_keyboard: rows };
}
