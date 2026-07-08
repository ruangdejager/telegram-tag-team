import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLogText } from '../src/logParser.js';
import { mergeSessions } from '../src/sessionMerger.js';
import { groupSessionsByDate, formatDailySummary } from '../src/dailySummary.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const units = { 866049074634379: 'device379.txt', 866049074634403: 'device403.txt' };
const blocksByUnit = {};
for (const [unitId, file] of Object.entries(units)) {
  const text = fs.readFileSync(path.join(__dirname, '..', 'test', 'fixtures', file), 'utf8');
  blocksByUnit[unitId] = parseLogText(text, unitId);
}

const sessions = mergeSessions(blocksByUnit).filter((s) => !s.discarded && s.total > 0);

const { byDate, dateOrder } = groupSessionsByDate(sessions);
console.log('=== Daily summaries ===');
for (const d of dateOrder) {
  console.log('\n' + formatDailySummary(d, byDate[d]));
}
