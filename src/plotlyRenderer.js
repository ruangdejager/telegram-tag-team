import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Path to the Python renderer script that lives alongside the app in the repo.
const RENDER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'plotly_render.py',
);

// Detect an available Python at module load. Prefers PYTHON_BIN if set, then
// tries the common names in order. Cached — probing per-render would waste
// hundreds of ms on the hot path.
function detectPython() {
  const candidates = [];
  if (process.env.PYTHON_BIN) candidates.push(process.env.PYTHON_BIN);
  candidates.push('python3', 'python', 'py');
  for (const bin of candidates) {
    try {
      const res = spawnSync(bin, ['--version'], { stdio: 'pipe' });
      if (res.status === 0) {
        const out = (res.stdout?.toString() || res.stderr?.toString() || '').trim();
        console.log(`plotlyRenderer: using Python "${bin}" (${out})`);
        return bin;
      }
    } catch { /* try next */ }
  }
  console.error('plotlyRenderer: no Python interpreter found on PATH (tried: ' + candidates.join(', ') + '). Chart/map features will fail with a clear error until this is fixed.');
  return null;
}

const PYTHON = detectPython();

// Renders a Plotly figure by shelling out to scripts/plotly_render.py (Python +
// Kaleido). Returns a PNG Buffer. Rejects on non-zero exit with stderr attached
// so figure-config bugs surface immediately in the caller's error handler.
//
// Not ideal for hot paths — Kaleido spawns/kills a headless Chromium per invocation
// (few hundred ms). All current callers (map/heatmap/battery buttons) are on-demand,
// so it's fine.
export function renderPlotly(figure, { width = 800, height = 500, scale = 2 } = {}) {
  return new Promise((resolve, reject) => {
    if (!PYTHON) {
      return reject(new Error(
        'Python not installed on this container. Chart/map rendering requires Python + plotly + kaleido — check nixpacks.toml.'
      ));
    }
    const proc = spawn(PYTHON, [RENDER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [];
    const err = [];
    proc.stdout.on('data', (c) => out.push(c));
    proc.stderr.on('data', (c) => err.push(c));
    proc.on('error', (spawnErr) => reject(new Error(`Failed to spawn python (${PYTHON}): ${spawnErr.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(
          `plotly_render exited ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 400) || '(no stderr)'}`
        ));
      }
      resolve(Buffer.concat(out));
    });
    try {
      proc.stdin.write(JSON.stringify({ figure, width, height, scale }));
      proc.stdin.end();
    } catch (writeErr) {
      reject(writeErr);
    }
  });
}
