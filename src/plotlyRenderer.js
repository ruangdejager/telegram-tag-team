import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Path to the Python renderer script that lives alongside the app in the repo.
const RENDER_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'plotly_render.py',
);

const PYTHON = process.env.PYTHON_BIN || 'python3';

// Renders a Plotly figure by shelling out to scripts/plotly_render.py (Python +
// Kaleido). Returns a PNG Buffer. Rejects on non-zero exit with stderr attached
// so figure-config bugs surface immediately in the caller's error handler.
//
// Not ideal for hot paths — Kaleido spawns/kills a headless Chromium per invocation
// (few hundred ms). All current callers (map/heatmap/battery buttons) are on-demand,
// so it's fine.
export function renderPlotly(figure, { width = 800, height = 500, scale = 2 } = {}) {
  return new Promise((resolve, reject) => {
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
