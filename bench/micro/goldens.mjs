// bench/micro/goldens.mjs — the EXACT microbench goldens (perf §9.4). Unlike the §9.4
// timing microbenches (soft drift gates), these two are HARD exact-value gates because
// getting them wrong "changes feel ~100×" (perf §7): the wheel-normalization outputs for a
// fixed event table, and the kinetic duration/position for fixed (speed, tuning). Pure
// functions, headless node — bundled from TS via esbuild (the §3.1 import wall keeps these
// in host/model; the bench reaches into ../../src like bench/conformance). Record-then-gate
// against goldens.json (the demo-chart discipline): first run records, later runs assert
// byte-equality. A drift here is a regression, not noise — so it is exact, not %-tolerant.
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const goldenPath = join(here, 'goldens.json');

// The TS entry: compute the two golden tables from the SHIPPED math (host wheel + model
// kinetic), serialize to plain numbers. __TV_PROFILE__=false (pure functions, no counters).
const source = `
  import { normalizeWheel } from './src/host/index';
  import { createKineticAnimation, kineticTuningForBarSpacing } from './src/model/index';

  // Fixed wheel event table (perf §9.4): the deltaMode/axis/modifier combinations whose
  // normalized { scroll, zoom } the feel depends on. PIXEL incl. the Windows-Chromium ÷dpr.
  const wheelTable = [
    { name: 'pixel dy=100',            e: { deltaMode: 0, deltaX: 0,   deltaY: 100, ctrlKey: false } },
    { name: 'line dy=3',               e: { deltaMode: 1, deltaX: 0,   deltaY: 3,   ctrlKey: false } },
    { name: 'page dy=1',               e: { deltaMode: 2, deltaX: 0,   deltaY: 1,   ctrlKey: false } },
    { name: 'pixel dx=120',            e: { deltaMode: 0, deltaX: 120, deltaY: 0,   ctrlKey: false } },
    { name: 'pixel dy=-50 ctrl',       e: { deltaMode: 0, deltaX: 0,   deltaY: -50, ctrlKey: true  } },
    { name: 'line dy=10 (zoom clamp)', e: { deltaMode: 1, deltaX: 0,   deltaY: 10,  ctrlKey: false } },
  ];
  const wheel = {
    default: wheelTable.map((t) => ({ name: t.name, out: normalizeWheel(t.e) })),
    speed2:  wheelTable.map((t) => ({ name: t.name, out: normalizeWheel(t.e, 2) })),
    winChromeDpr2: wheelTable.map((t) => ({ name: t.name, out: normalizeWheel(t.e, 1, true, 2) })),
  };

  // Fixed kinetic (speed, tuning) cases (perf §9.4): duration + sampled positions.
  function kineticCase(barSpacing, velocity) {
    const tuning = kineticTuningForBarSpacing(barSpacing);
    const anim = createKineticAnimation(0, velocity, 0, tuning);
    // The closed-form duration is recoverable from positionAt at a huge t (resting point)
    // plus sampled positions; record the curve at fixed offsets for an exact gate.
    return {
      barSpacing, velocity, epsilon: tuning.epsilon,
      pos0:   anim.positionAt(0),
      pos100: anim.positionAt(100),
      pos500: anim.positionAt(500),
      rest:   anim.positionAt(1e9),
      finished0:   anim.finished(0),
      finished500: anim.finished(500),
      finishedRest: anim.finished(1e9),
    };
  }
  const kinetic = [
    kineticCase(6, 0.5),
    kineticCase(12, 0.5),
    kineticCase(6, 2.0),
    kineticCase(50, 0.3),
  ];

  export const goldens = { wheel, kinetic };
`;

const dir = mkdtempSync(join(tmpdir(), 'tvgold-'));
const out = join(dir, 'goldens.mjs');
await build({
  stdin: { contents: source, resolveDir: join(here, '..', '..'), loader: 'ts', sourcefile: 'goldens.ts' },
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  define: { __DEV__: 'false', __TV_PROFILE__: 'false' },
  logLevel: 'warning',
});
const { goldens } = await import('file://' + out.replace(/\\/g, '/'));
rmSync(dir, { recursive: true, force: true });

const actual = JSON.stringify(goldens, null, 2);
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, actual + '\n');
  console.log('micro/goldens: recorded baseline -> ' + goldenPath);
  process.exit(0);
}
const expected = readFileSync(goldenPath, 'utf8').replace(/\r\n/g, '\n').trimEnd();
if (actual.replace(/\r\n/g, '\n').trimEnd() !== expected) {
  console.error('micro/goldens: EXACT-value mismatch vs goldens.json (perf §9.4 — feel-breaking).');
  console.error('  re-record only with a reviewed rationale (the wheel/kinetic constants changed on purpose).');
  process.exit(1);
}
console.log('micro/goldens: wheel + kinetic exact values match goldens.json.');
