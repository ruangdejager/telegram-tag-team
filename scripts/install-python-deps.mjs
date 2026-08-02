// Runs after `npm install` (via package.json's postinstall script). Installs
// plotly + kaleido into whichever Python is on PATH. If no Python is available
// (typical local dev on machines without it), this exits 0 so npm install doesn't
// fail — the map/heatmap features will just show their "Python not installed"
// message at runtime. On Railpack, python is provisioned via railpack.json's
// packages.python, so this runs and installs the deps into that Python.

import { spawnSync } from 'node:child_process';

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

console.log(`install-python-deps: using ${py}; installing plotly==5.24.1 kaleido==0.2.1...`);
const args = ['-m', 'pip', 'install', '--break-system-packages', '--no-cache-dir', 'plotly==5.24.1', 'kaleido==0.2.1'];
const res = spawnSync(py, args, { stdio: 'inherit' });
process.exit(res.status ?? 1);
