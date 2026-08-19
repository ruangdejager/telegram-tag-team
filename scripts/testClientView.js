import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogText } from '../src/logParser.js';
import { mergeSessions } from '../src/sessionMerger.js';
import { formatSessionMessage, formatTimeoutAlert, formatLatestCount, formatBatteryStatusList, formatCountWindow } from '../src/formatter.js';
import { groupSessionsByDate, formatDailySummary } from '../src/dailySummary.js';
import { buildFullKeyboard, buildSimpleKeyboard } from '../src/keyboard.js';
import { buildTagSeries } from '../src/analytics.js';
import { ageLabel } from '../src/maps.js';
import { jhbMidnightMsDaysAgo } from '../src/utils.js';
import { findTagsMissingFromLatest, formatMissingTags } from '../src/missingTags.js';

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
assert(client.includes('🟢 Fully charged · 🔵 Good · 🟠 watch · 🔴 low battery (gps not allowed)'), 'client shows new battery legend wording');
// Dev keeps everything it had.
assert(dev.includes('Discovery took') && dev.includes('Combined ->') && /\bFW\b/.test(dev), 'dev still shows duration + breakdown + FW');
assert(/\b3[0-9]{3}\b/.test(dev), 'dev still shows raw mV battery numbers');
assert(dev.includes('🟢≥3800mV Fully charged') && dev.includes('low battery (gps not allowed)'), 'dev shows numeric thresholds + new legend wording');

console.log('\n--- formatLatestCount assertions ---');
const latestCount = formatLatestCount(session);
console.log(latestCount);
assert(latestCount.includes(session.time) && latestCount.includes(session.date), 'latest count shows discovery time/date');
assert(latestCount.includes('<i>Unique tags detected:</i>') && latestCount.includes(`<b>${session.total}</b>`), 'latest count shows italic label + bold count on its own line');
assert(!latestCount.includes('Discovery took') && !latestCount.includes('Combined ->') && !latestCount.includes('866049074634379'), 'latest count hides duration/breakdown/IMEIs');
assert(!latestCount.includes('Tag ID'), 'latest count has no per-tag table');

console.log('\n--- formatBatteryStatusList assertions ---');
const series = buildTagSeries(sessions);
const battList = formatBatteryStatusList(series);
console.log(battList);
assert(battList.includes('Tag ID') && battList.includes('St'), 'battery list shows Tag ID + St columns');
assert(!/\bGPS\b/.test(battList), 'battery list has no GPS column');
assert(!/\b3[0-9]{3}\b/.test(battList), 'battery list does NOT show raw mV numbers');
assert(battList.includes('Fully charged'), 'battery list includes shared legend text');

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
const clientKb = JSON.stringify(buildFullKeyboard(false, 'client'));
const devKb = JSON.stringify(buildFullKeyboard(false, 'dev'));
assert(!clientKb.includes('batt_trend_prompt'), 'client keyboard omits Trend');
assert(devKb.includes('batt_trend_prompt'), 'dev keyboard keeps Trend');
assert(clientKb.includes('analytics_batt_list') && clientKb.includes('gps_prompt') && clientKb.includes('missing_tags'), 'client keeps Battery List/GPS/Missing');
assert(!clientKb.includes('analytics_batt_chart'), 'client no longer has the battery chart button');
assert(devKb.includes('analytics_batt_chart') && !devKb.includes('analytics_batt_list'), 'dev still uses the battery chart, not the list');
assert(clientKb.includes('latest_count') && devKb.includes('latest_count'), 'both levels have Latest Count');
assert(!clientKb.includes('hist_latest') && !clientKb.includes('hist_4h') && !clientKb.includes('hist_24h'), 'client drops Latest/4h/24h');
assert(devKb.includes('hist_latest') && devKb.includes('hist_4h') && devKb.includes('hist_24h'), 'dev keeps Latest/4h/24h');
assert(clientKb.includes('hist_1d') && clientKb.includes('hist_3d') && !clientKb.includes('hist_7d'), 'client keeps 1d/3d, drops 7d');
assert(devKb.includes('hist_1d') && devKb.includes('hist_3d') && devKb.includes('hist_7d'), 'dev keeps 1d/3d/7d');
assert(clientKb.includes('GPS Query') && devKb.includes('GPS Query'), 'both levels rename GPS to GPS Query');
// Map / Heatmap / Latest Positions are dev-only: client keyboard is intentionally
// map-free (client audience gets the count + summary view instead).
assert(devKb.includes('GPS Status Map') && !clientKb.includes('GPS Status Map'), 'GPS Status Map is dev-only');
assert(devKb.includes('latest_positions_map') && !clientKb.includes('latest_positions_map'), 'Latest Positions is dev-only');
assert(devKb.includes('Latest Positions') && !clientKb.includes('Latest Positions'), 'Latest Positions label is dev-only');
assert(devKb.includes('heatmap_default') && !clientKb.includes('heatmap_default'), 'Heatmap is dev-only');
assert(devKb.includes('position_map') && !clientKb.includes('position_map'), 'GPS Status Map callback is dev-only');
assert(clientKb.includes('Battery Status List') && devKb.includes('Battery Level List'), 'client/dev battery button labels diverge');

console.log('\n--- simple keyboard assertions ---');
const simpleKb = JSON.stringify(buildSimpleKeyboard());
assert(simpleKb.includes('latest_count') && simpleKb.includes('"menu"'), 'simple keyboard has Latest Count + Menu');
assert(!simpleKb.includes('hist_1d') && !simpleKb.includes('missing_tags') && !simpleKb.includes('optin') && !simpleKb.includes('optout'), 'simple keyboard has no other buttons');
const simpleButtonCount = JSON.parse(simpleKb).inline_keyboard.flat().length;
assert(simpleButtonCount === 2, 'simple keyboard has exactly 2 buttons');

console.log('\n--- map age-bucket assertions ---');
const HOUR = 60 * 60 * 1000;
assert(ageLabel(1 * HOUR) === '🟢 ≤2h', 'age 1h -> ≤2h green');
assert(ageLabel(6 * HOUR) === '🟡 ≤12h', 'age 6h -> ≤12h yellow');
assert(ageLabel(20 * HOUR) === '🟠 ≤24h', 'age 20h -> ≤24h orange');
assert(ageLabel(30 * HOUR) === '🔴 > 1d', 'age 30h -> > 1d red');

console.log('\n--- jhbMidnightMsDaysAgo assertions ---');
// 04-Aug-2026 10:30 UTC = 12:30 JHB (afternoon) -> today's JHB midnight is 03-Aug-2026 22:00 UTC.
const noonJhbNow = Date.UTC(2026, 7, 4, 10, 30, 0);
assert(jhbMidnightMsDaysAgo(0, noonJhbNow) === Date.UTC(2026, 7, 3, 22, 0, 0), 'midnight(0) from afternoon JHB is today');
assert(jhbMidnightMsDaysAgo(2, noonJhbNow) === Date.UTC(2026, 7, 1, 22, 0, 0), 'midnight(2) from afternoon JHB is 2 days back');
// 00:05 JHB (just after midnight) = 03-Aug-2026 22:05 UTC -> "today" is still 04-Aug JHB.
const justAfterMidnightJhb = Date.UTC(2026, 7, 3, 22, 5, 0);
assert(jhbMidnightMsDaysAgo(0, justAfterMidnightJhb) === Date.UTC(2026, 7, 3, 22, 0, 0), 'midnight(0) just after JHB midnight stays on today');
// 23:55 JHB (just before midnight) = 04-Aug-2026 21:55 UTC -> "today" is still 04-Aug JHB, not tomorrow.
const justBeforeMidnightJhb = Date.UTC(2026, 7, 4, 21, 55, 0);
assert(jhbMidnightMsDaysAgo(0, justBeforeMidnightJhb) === Date.UTC(2026, 7, 3, 22, 0, 0), 'midnight(0) just before JHB midnight does not roll to tomorrow');

console.log('\n--- findTagsMissingFromLatest assertions ---');
// Synthetic sessions (ascending): round 1 has A, B, C; round 2 (latest) only has A.
// B was last seen 3h ago (within threshold, unflagged). C was last seen 10h ago
// (past the 8h threshold, flagged). A is in the latest round, so not "missing" at all.
const missingNow = new Date('2026-08-06T12:00:00+02:00');
const syntheticSessions = [
  {
    timestamp: '2026-08-06T02:00:00+02:00', date: '06-Aug-2026', time: '02:00:00',
    tags: [{ id: 'A', battery: 4000 }, { id: 'B', battery: 3700 }, { id: 'C', battery: 3400 }],
  },
  {
    timestamp: '2026-08-06T09:00:00+02:00', date: '06-Aug-2026', time: '09:00:00',
    tags: [{ id: 'A', battery: 3990 }, { id: 'B', battery: 3690 }],
  },
  {
    timestamp: '2026-08-06T11:00:00+02:00', date: '06-Aug-2026', time: '11:00:00',
    tags: [{ id: 'A', battery: 3980 }],
  },
];
const missingFromLatest = findTagsMissingFromLatest(syntheticSessions, missingNow, { windowHours: 7 * 24, thresholdHours: 8 });
assert(missingFromLatest.length === 2, 'A (in latest round) is excluded; B and C are missing');
assert(!missingFromLatest.some((m) => m.id === 'A'), 'A is not on the missing list');
const bEntry = missingFromLatest.find((m) => m.id === 'B');
const cEntry = missingFromLatest.find((m) => m.id === 'C');
assert(bEntry && bEntry.flagged === false, 'B (3h since last seen) is not flagged');
assert(cEntry && cEntry.flagged === true, 'C (10h since last seen) is flagged');
assert(bEntry.lastSeen.battery === 3690 && cEntry.lastSeen.battery === 3400, 'each entry carries its last-known battery mV');
const missingTextDev = formatMissingTags(missingFromLatest, { windowHours: 7 * 24, thresholdHours: 8, level: 'dev' });
console.log(missingTextDev);
assert(missingTextDev.includes('🔴') && missingTextDev.includes(' C  —'), 'formatted list shows 🔴 flag next to C');
assert(!/🔴\s+B\s+—/.test(missingTextDev), 'B is listed without the 🔴 flag');
assert(missingTextDev.includes('3690mV') && missingTextDev.includes('3400mV'), 'dev missing list shows last-known battery mV');
const missingTextClient = formatMissingTags(missingFromLatest, { windowHours: 7 * 24, thresholdHours: 8, level: 'client' });
assert(!missingTextClient.includes('mV'), 'client missing list hides battery mV');

console.log('\n--- formatCountWindow assertions ---');
const countText4h = formatCountWindow({ hours: 4, uniqueTagCount: 12, sessionCount: 8 });
console.log(countText4h);
assert(countText4h.includes('last 4h'), 'count-window header renders hour window');
assert(countText4h.includes('<b>12</b>'), 'count-window shows unique tag count as bold headline');
assert(countText4h.includes('across 8 discoveries'), 'count-window shows discovery session count (plural)');
const countText1 = formatCountWindow({ hours: 1, uniqueTagCount: 3, sessionCount: 1 });
assert(countText1.includes('across 1 discovery'), 'count-window uses singular when only 1 discovery');
const countText3d = formatCountWindow({ hours: 72, uniqueTagCount: 25, sessionCount: 40 });
assert(countText3d.includes('last 3d'), 'count-window renders day window when hours is a day multiple');

console.log('\n--- v2.1.x bare-anchor parser assertions ---');
const bareAnchorText = read('bareAnchorV21.txt');
const bareBlocks = parseLogText(bareAnchorText, 'X');
assert(bareBlocks.length === 2, 'both anchors (full and bare) produce blocks');
assert(bareBlocks[1].timestamp === '2026-08-19T09:01:52+02:00', 'bare anchor timestamp uses inherited date');
assert(bareBlocks[1].tags.length === 3, 'bare-anchor discovery yields 3 tags');
assert(bareBlocks[1].unitBatteryMv === 4016, 'bare-anchor block inherits unit battery from earlier full anchor');

console.log('\n--- client timeout alert assertions ---');
const fakeTimeout = { timestamp: session.timestamp, timeoutUnitIds: ['866049074634379'], involvedUnitIds: ['866049074634379', '866049074634403'] };
const clientAlert = formatTimeoutAlert(fakeTimeout, 'client');
assert(!clientAlert.includes('866049074634379'), 'client timeout alert hides IMEIs');

console.log(failures === 0 ? '\nAll client-view assertions passed.' : `\n${failures} assertion(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
