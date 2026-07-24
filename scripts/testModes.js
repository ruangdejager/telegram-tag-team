import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogText } from '../src/logParser.js';
import { mergeSessions } from '../src/sessionMerger.js';
import { formatSessionMessage } from '../src/formatter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simulates one device running advanced mode and another running basic mode,
// both reporting on the same discovery round (some tags seen by both).
const units = { UNIT_ADVANCED: 'advancedMode.txt', UNIT_BASIC: 'basicMode.txt' };
const blocksByUnit = {};
for (const [unitId, file] of Object.entries(units)) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', file), 'utf8');
  blocksByUnit[unitId] = parseLogText(text, unitId);
  console.log(`\n--- Parsed tags for ${unitId} ---`);
  for (const b of blocksByUnit[unitId]) {
    for (const t of b.tags) {
      console.log(JSON.stringify(t));
    }
  }
}

const sessions = mergeSessions(blocksByUnit).filter((s) => !s.discarded);
console.log(`\n=== Merged sessions (${sessions.length}) ===`);
for (const s of sessions) {
  console.log(formatSessionMessage(s));
}
