import { buildInlineKeyboard } from './keyboard.js';

async function createQuickChart(chartConfig, width = 800, height = 420) {
  const body = { chart: chartConfig, width, height, version: '3', backgroundColor: 'white' };
  const res = await fetch('https://quickchart.io/chart/create', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`QuickChart error: ${(await res.text()).slice(0, 200)}`);
  const result = await res.json();
  if (!result.success) throw new Error('QuickChart returned success:false');
  return result.url;
}

export async function sendBatteryChart(bot, chatId, series, subscribed) {
  const CRITICAL = 3400, WARNING = 3600;
  const tags = Object.keys(series).map((id) => {
    const readings = series[id];
    const latest = readings[readings.length - 1].battery;
    const colour = latest < CRITICAL ? '#e74c3c' : latest < WARNING ? '#f39c12' : '#2ecc71';
    return { id, latest, colour };
  });
  tags.sort((a, b) => a.latest - b.latest);

  const chartConfig = {
    type: 'bar',
    data: {
      labels: tags.map((t) => t.id),
      datasets: [{ label: 'Battery (mV)', data: tags.map((t) => t.latest), backgroundColor: tags.map((t) => t.colour) }],
    },
    options: {
      plugins: {
        legend: { display: false },
        title: { display: true, text: 'Tag Battery Levels', font: { size: 16 } },
      },
      scales: { y: { min: 3200, title: { display: true, text: 'mV' } }, x: { ticks: { maxRotation: 45 } } },
    },
  };

  try {
    const url = await createQuickChart(chartConfig, 800, 440);
    await bot.sendPhoto(chatId, url, {
      caption: '📈 Battery levels — sorted worst to best',
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard(subscribed),
    });
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Chart unavailable — try again in a moment.\n\n${err.message}`, {
      parse_mode: 'HTML',
      reply_markup: buildInlineKeyboard(subscribed),
    });
  }
}
