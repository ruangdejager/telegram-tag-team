import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogText } from '../src/logParser.js';
import { mergeSessions } from '../src/sessionMerger.js';
import { formatSessionMessage, formatTimeoutAlert } from '../src/formatter.js';
import { groupSessionsByDate, formatDailySummary } from '../src/dailySummary.js';
import { buildInlineKeyboard } from '../src/keyboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', f), 'utf8');

let failures = 0;
function assert(cond, msg) {
  if (cond) { console.log('  ok: ' + msg); } else { console.error('  FAIL: ' + msg); failures++; }
}

// Build a real multi-device session from the advanced+basic fixtures.
const blocksByUnit = {
  '866049074634379': parseLogText(read('advancedMode.txt'), '866049074634379'),
  '866049074634403': parseLogText(read('basicMode.txt'), '866049074634403'),
};
const sessions = mergeSessions(blocksByUnit).filter((s) => !s.discarded && s.total > 0);
const session = sessions[0];

console.log('=== formatSessionMessage: dev ===');
const dev = formatSessionMessage(session, 'dev');
console.log(dev);
console.log('\n=== formatSessionMessage: client ===');
const client = formatSessionMessage(session, 'client');
console.log(client);

console.log('\n--- client raw discovery assertions ---');
assert(client.includes('Tag ID') && client.includes('Batt') && client.includes('GPS'), 'client shows Tag ID / Batt / GPS columns');
assert(!/\bHops\b/.test(client) && !/\bRSSI\b/.test(client) && !/\bWaves\b/.test(client) && !/\bMov\b/.test(client), 'client hides Hops/RSSI/Waves/Mov');
assert(!/\bFW\b/.test(client), 'client hides FW column');
assert(!client.includes('Discovery took'), 'client hides discovery duration');
assert(!client.includes('Combined ->') && !client.includes('866049074634379'), 'client hides per-device / IMEI breakdown');
assert(client.includes(`Unique tags detected: ${session.total}`), 'client surfaces unique-tag count prominently in header');
assert(/[🟢🔵🟠🔴]/u.test(client), 'client uses battery status dots (no raw mV shown)');
assert(!/\b3[0-9]{3}\b/.test(client), 'client does NOT show raw millivolt battery numbers');
// Dev keeps everything it had.
assert(dev.includes('Discovery took') && dev.includes('Combined ->') && /\bFW\b/.test(dev), 'dev still shows duration + breakdown + FW');
assert(/\b3[0-9]{3}\b/.test(dev), 'dev still shows raw mV battery numbers');

console.log('\n--- client daily summary assertions ---');
const { byDate, dateOrder } = groupSessionsByDate(sessions);
const d = dateOrder[0];
const devSummary = formatDailySummary(d, byDate[d], 'dev');
const clientSummary = formatDailySummary(d, byDate[d], 'client');
console.log(clientSummary);
assert(clientSummary.includes('Time') && clientSummary.includes('Combined'), 'client summary shows Time + Combined');
assert(!clientSummary.includes('Per-Device'), 'client summary hides Per-Device column');
assert(!clientSummary.includes('Unique tags for the day'), 'client summary hides day tag-ID list');
assert(devSummary.includes('Per-Device') && devSummary.includes('Unique tags for the day'), 'dev summary keeps per-device + day list');

console.log('\n--- client keyboard assertions ---');
const clientKb = JSON.stringify(buildInlineKeyboard(false, 'client'));
const devKb = JSON.stringify(buildInlineKeyboard(false, 'dev'));
assert(!clientKb.includes('batt_trend_prompt'), 'client keyboard omits Trend');
assert(devKb.includes('batt_trend_prompt'), 'dev keyboard keeps Trend');
assert(clientKb.includes('analytics_batt_chart') && clientKb.includes('gps_prompt') && clientKb.includes('missing_tags'), 'client keeps Battery/GPS/Missing');

console.log('\n--- client timeout alert assertions ---');
const fakeTimeout = { timestamp: session.timestamp, timeoutUnitIds: ['866049074634379'], involvedUnitIds: ['866049074634379', '866049074634403'] };
const clientAlert = formatTimeoutAlert(fakeTimeout, 'client');
assert(!clientAlert.includes('866049074634379'), 'client timeout alert hides IMEIs');

console.log(failures === 0 ? '\nAll client-view assertions passed.' : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
