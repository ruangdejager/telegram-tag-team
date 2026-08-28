// Regression checks for dating discovery blocks on firmware that logs bare
// (undated) discovery anchors — v2.1.x drops into "minimal syslog mode" for the
// round, so the anchor's calendar date has to come from the ordinary dated log
// lines before or after it, including across midnight.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogText } from '../src/logParser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', name), 'utf8');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) {
    console.log(`      expected: ${JSON.stringify(expected)}`);
    console.log(`      actual:   ${JSON.stringify(actual)}`);
  }
}

// Carrying the date forward past midnight: without the rollover step, the 00:xx and
// 01:xx rounds are dated a day early and sort *before* the 23:00 one, so the bot
// reports a stale round as "latest".
{
  const blocks = parseLogText(fixture('bareAnchorMidnight.txt'), 'unit');
  check('midnight: block timestamps', blocks.map((b) => b.timestamp), [
    '2026-08-27T23:00:30+02:00',
    '2026-08-28T00:00:26+02:00',
    '2026-08-28T00:34:03+02:00',
    '2026-08-28T01:00:25+02:00',
  ]);
  // The 00:34 round is a FOTA chunk (8-char pseudo-tag), so it parses to zero tags.
  check('midnight: tags per block', blocks.map((b) => b.tags.map((t) => t.id)), [
    ['221D', '2D94'], ['221D', '2D94'], [], ['221D'],
  ]);
  check('midnight: unit battery carried forward', blocks.map((b) => b.unitBatteryMv), [4079, 4079, 4079, 4079]);
}

// Dating backwards: a fetch window can start mid-day with only bare anchors, the
// first dated line arriving after midnight. Those earlier rounds belong to the
// previous day, and must be parsed rather than dropped as undatable.
{
  const blocks = parseLogText(fixture('bareAnchorBackfill.txt'), 'unit');
  check('backfill: block timestamps', blocks.map((b) => b.timestamp), [
    '2026-08-27T22:00:27+02:00',
    '2026-08-27T23:00:30+02:00',
    '2026-08-28T00:00:26+02:00',
  ]);
}

console.log(failures === 0 ? '\nAll bare-anchor checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
