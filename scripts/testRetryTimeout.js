import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogText } from '../src/logParser.js';
import { mergeSessions } from '../src/sessionMerger.js';
import { formatSessionMessage, formatTimeoutAlert } from '../src/formatter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (file) => fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', file), 'utf8');

function assert(cond, msg) {
  if (!cond) throw new Error('ASSERTION FAILED: ' + msg);
  console.log('  ok: ' + msg);
}

// --- Scenario 1: both devices fail then retry-succeed in the same bracket ---
console.log('\n=== Scenario 1: retry-then-success (both devices) ===');
{
  const blocksByUnit = {
    UNIT_A: parseLogText(read('retryTimeoutA.txt'), 'UNIT_A'),
    UNIT_B: parseLogText(read('retryTimeoutB.txt'), 'UNIT_B'),
  };
  assert(blocksByUnit.UNIT_A.some((b) => b.isTimeout), 'UNIT_A has a timeout block');
  assert(blocksByUnit.UNIT_A.some((b) => !b.isTimeout && b.total === 18), 'UNIT_A has a successful 18-tag block');

  // Status-only lines ("gsm ifdown", "tag_fota: check requested", etc.) also match the
  // block-header pattern and produce harmless empty (total=0, non-discarded) sessions —
  // filter them out the same way production code (history.js) does.
  const sessions = mergeSessions(blocksByUnit).filter((s) => s.discarded || s.total > 0);
  assert(sessions.length === 1, 'exactly one meaningful session bucket');
  const s = sessions[0];
  assert(s.discarded === false, 'session is NOT discarded (retry succeeded)');
  assert(s.perDeviceTotals.UNIT_A === 18, `UNIT_A total is 18 (got ${s.perDeviceTotals.UNIT_A})`);
  assert(s.perDeviceTotals.UNIT_B === 12, `UNIT_B total is 12 (got ${s.perDeviceTotals.UNIT_B})`);
  assert(s.durationSeconds === 40, `duration is 40s (bracket 20:00:00, success at 20:00:40) (got ${s.durationSeconds})`);
  console.log(formatSessionMessage(s));
}

// --- Scenario 2: full failure (no successful block from any device) ---
console.log('\n=== Scenario 2: full failure, no retry ===');
{
  const blocksByUnit = {
    UNIT_A: parseLogText(read('fullTimeoutA.txt'), 'UNIT_A'),
    UNIT_B: parseLogText(read('fullTimeoutB.txt'), 'UNIT_B'),
  };
  // Status-only lines ("gsm ifdown", "tag_fota: check requested", etc.) also match the
  // block-header pattern and produce harmless empty (total=0, non-discarded) sessions —
  // filter them out the same way production code (history.js) does.
  const sessions = mergeSessions(blocksByUnit).filter((s) => s.discarded || s.total > 0);
  assert(sessions.length === 1, 'exactly one meaningful session bucket');
  const s = sessions[0];
  assert(s.discarded === true, 'session IS discarded (no device succeeded)');
  assert(s.timeoutUnitIds.includes('UNIT_A') && s.timeoutUnitIds.includes('UNIT_B'), 'both units listed as timed out');
  console.log(formatTimeoutAlert(s));
}

// --- Scenario 3: one device drops out (only timeout, no retry), other succeeds ---
console.log('\n=== Scenario 3: one device fails outright, other succeeds ===');
{
  const blocksByUnit = {
    UNIT_A: parseLogText(read('retryTimeoutA.txt'), 'UNIT_A'), // has a successful retry at :40
    UNIT_B: parseLogText(read('partialDropoutB.txt'), 'UNIT_B'), // only ever times out
  };
  // Status-only lines ("gsm ifdown", "tag_fota: check requested", etc.) also match the
  // block-header pattern and produce harmless empty (total=0, non-discarded) sessions —
  // filter them out the same way production code (history.js) does.
  const sessions = mergeSessions(blocksByUnit).filter((s) => s.discarded || s.total > 0);
  assert(sessions.length === 1, 'exactly one meaningful session bucket');
  const s = sessions[0];
  assert(s.discarded === false, 'session is NOT discarded (UNIT_A succeeded)');
  assert(!s.involvedUnitIds.includes('UNIT_B'), 'UNIT_B is excluded (never succeeded this round)');
  assert(s.involvedUnitIds.includes('UNIT_A'), 'UNIT_A is included');
  console.log(formatSessionMessage(s));
}

console.log('\nAll retry/timeout scenarios passed.');
