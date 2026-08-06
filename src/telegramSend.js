import { buildSimpleKeyboard } from './keyboard.js';

// Common wrapper for the "send a photo (URL or Buffer) with our menu re-attached,
// fall back to a friendly text error on failure" pattern. Shared by the battery
// charts, position map and heatmap so error handling and menu re-attachment
// happen in exactly one place. Re-attaches the simple default screen (Latest
// Count + Menu) rather than the full button list.
export async function sendPhotoOrError(bot, chatId, subscribed, photo, caption, { level = 'dev', filename } = {}) {
  try {
    const options = { caption, parse_mode: 'HTML', reply_markup: buildSimpleKeyboard() };
    // node-telegram-bot-api needs a filename when uploading a raw Buffer.
    const fileOpts = Buffer.isBuffer(photo) ? { filename: filename || 'chart.png', contentType: 'image/png' } : undefined;
    if (fileOpts) {
      await bot.sendPhoto(chatId, photo, options, fileOpts);
    } else {
      await bot.sendPhoto(chatId, photo, options);
    }
  } catch (err) {
    await bot.sendMessage(chatId, `⚠️ Image unavailable — try again in a moment.\n\n${err.message}`, {
      parse_mode: 'HTML',
      reply_markup: buildSimpleKeyboard(),
    });
  }
}
