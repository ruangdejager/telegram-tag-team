export function buildInlineKeyboard(subscribed) {
  return {
    inline_keyboard: [
      [
        { text: '📋 Last Discovery', callback_data: 'hist_latest' },
        { text: '📋 Last 4h Raw Discovery Data', callback_data: 'hist_4h' },
        { text: '📋 Last 24h Raw Discovery Data', callback_data: 'hist_24h' },
      ],
      [
        { text: '📊 3-Day Summary', callback_data: 'hist_3d' },
        { text: '📊 7-Day Summary', callback_data: 'hist_7d' },
      ],
      [
        { text: '🔍 Missing Tags', callback_data: 'missing_tags' },
        { text: '📍 Query Tag GPS', callback_data: 'gps_prompt' },
      ],
      [
        { text: '📈 Battery Chart', callback_data: 'analytics_batt_chart' },
        { text: '📈 Battery Chart (Filter)', callback_data: 'batt_chart_filter' },
      ],
      [
        subscribed
          ? { text: '❌ Opt Out of Live Updates', callback_data: 'optout' }
          : { text: '✅ Opt In for Live Updates', callback_data: 'optin' },
      ],
    ],
  };
}
