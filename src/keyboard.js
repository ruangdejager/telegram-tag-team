export function buildInlineKeyboard(subscribed) {
  return {
    inline_keyboard: [
      [{ text: '📋 Last 24h Raw Discovery Data', callback_data: 'hist_24h' }],
      [
        { text: '📊 3-Day Summary', callback_data: 'hist_3d' },
        { text: '📊 7-Day Summary', callback_data: 'hist_7d' },
        { text: '📊 All Time', callback_data: 'hist_all' },
      ],
      [{ text: '📈 Battery Chart', callback_data: 'analytics_batt_chart' }],
      [
        subscribed
          ? { text: '❌ Opt Out of Live Updates', callback_data: 'optout' }
          : { text: '✅ Opt In for Live Updates', callback_data: 'optin' },
      ],
    ],
  };
}
