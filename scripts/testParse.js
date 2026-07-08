import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogText } from '../src/logParser.js';
import { mergeSessions } from '../src/sessionMerger.js';
import { formatSessionMessage, formatTimeoutAlert } from '../src/formatter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const units = {
  866049074634379: 'device379.txt',
  866049074634403: 'device403.txt',
};

const blocksByUnit = {};
for (const [unitId, file] of Object.entries(units)) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', file), 'utf8');
  blocksByUnit[unitId] = parseLogText(text, unitId);
  console.log(`\n--- Parsed blocks for ${unitId} ---`);
  for (const b of blocksByUnit[unitId]) {
    console.log(`${b.timestamp} isTimeout=${b.isTimeout} total=${b.total}`);
  }
}

const sessions = mergeSessions(blocksByUnit); // uses config default (MERGE_BRACKET_MINUTES)

console.log(`\n=== Merged sessions (${sessions.length}) ===`);
for (const s of sessions) {
  console.log('\n----------------------------------------');
  if (s.discarded) {
    console.log(`[DISCARDED] ${s.timestamp} timeout on ${s.timeoutUnitIds.join(',')} involved ${s.involvedUnitIds.join(',')}`);
    console.log(formatTimeoutAlert(s));
  } else {
    console.log(`${s.timestamp} involved=${s.involvedUnitIds.join(',')} total=${s.total}`);
    console.log(s.tags.map((t) => `${t.id}(from ${t.sourceUnitId})`).join(', '));
    console.log('\n--- formatted message ---');
    console.log(formatSessionMessage(s));
  }
}
