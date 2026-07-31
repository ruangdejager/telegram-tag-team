export function buildInlineKeyboard(subscribed) {
  return {
    inline_keyboard: [
      [
        { text: '📋 Latest', callback_data: 'hist_latest' },
        { text: '📋 4h', callback_data: 'hist_4h' },
        { text: '📋 24h', callback_data: 'hist_24h' },
      ],
      [
        { text: '📊 3d', callback_data: 'hist_3d' },
        { text: '📊 7d', callback_data: 'hist_7d' },
      ],
      [
        { text: '🔍 Missing', callback_data: 'missing_tags' },
        { text: '📍 GPS', callback_data: 'gps_prompt' },
      ],
      [
        { text: '🔋 Battery', callback_data: 'analytics_batt_chart' },
        { text: '📉 Trend', callback_data: 'batt_trend_prompt' },
      ],
      [
        subscribed
          ? { text: '❌ Opt Out', callback_data: 'optout' }
          : { text: '✅ Opt In', callback_data: 'optin' },
      ],
    ],
  };
}
