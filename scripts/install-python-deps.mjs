// Runs after `npm install` (via package.json's postinstall script). Installs
// plotly + kaleido into ./vendor/python inside the project so the packages live
// on the same filesystem tree as the Node app and are guaranteed to survive
// Railpack's build→deploy image handoff. plotly_render.py prepends this dir to
// sys.path so a plain `import plotly` finds them there without needing global
// site-packages to survive the deploy step.
//
// If Python isn't on PATH (typical local dev), this exits 0 so npm install
// doesn't fail — map/heatmap will show their "Python not installed" message
// at runtime instead.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const TARGET = path.resolve(process.cwd(), 'vendor', 'python');

const candidates = ['python3', 'python', 'py'];
let py = null;
for (const bin of candidates) {
  try {
    const res = spawnSync(bin, ['--version'], { stdio: 'pipe' });
    if (res.status === 0) { py = bin; break; }
  } catch { /* try next */ }
}

if (!py) {
  console.log('install-python-deps: no Python interpreter found — skipping (map/heatmap will be disabled at runtime).');
  process.exit(0);
}

fs.mkdirSync(TARGET, { recursive: true });
console.log(`install-python-deps: using ${py}; installing plotly==5.24.1 kaleido==0.2.1 into ${TARGET}...`);
const res = spawnSync(
  py,
  ['-m', 'pip', 'install', '--target', TARGET, '--no-cache-dir', 'plotly==5.24.1', 'kaleido==0.2.1'],
  { stdio: 'inherit' },
);
process.exit(res.status ?? 1);
