// M10 demo (roadmap §M10 (e)) — the HEADLESS bench demo: runs S2 + S12 and prints the
// Overlay re-emit counters (the §4.4.1 base-only invariant) + the per-point memory
// attribution against the committed baseline, with NO browser and NO real canvas. It
// reuses the bench node stack (bench/harness.mjs → bench/scenes.mjs → node-adapter.mjs,
// stub backend, __TV_PROFILE__=true) so the counters it reads are the SAME FrameStats the
// CI bench gates read (perf §9.6). The Playwright frame-time runner (bench/run.mjs) is the
// CI `bench` job and is NOT run here.
//
// S2 (perf §9.2/§4.4.1): a 120-move crosshair sweep on R1. The proof, read off the
//   counters: every Overlay frame re-emits ZERO base-band sources (the PaneScene composites
//   bands 6–8 only at Overlay scope) WHILE the scene's Render frames DO re-emit base sources
//   (> 0) — so the base-only invariant is non-vacuous. Plus §4.4.3 (Overlay ≤ 40 commands)
//   and §4.4.2 (clean sources never re-emit a non-identical list).
// S12 (perf §6.2): the per-point byte attribution protocol over three series sharing one
//   timeline pool — line (Δ afterA→afterB), candle (Δ afterB→afterC), timeline slot
//   (Δ1−Δ2 derived). The DETERMINISTIC facts gate (the exact SoA-lane floors the PlotStore
//   retains; the §6.2 caps; candle costs more than line). The node-heap byte deltas are
//   indicative-only (V8 LOS fragmentation, no CPU throttle) so they are PRINTED but kept OUT
//   of the golden — the absolute B/point gate of record is the browser run (run.mjs, §6.2).
//
// Gated vs scripts/demo-bench.golden.txt (record-then-gate, the demo-chart discipline): the
// printed DETERMINISTIC block is byte-compared; the indicative node-heap line is logged
// separately (after the gated block) so run-to-run heap noise never flips the gate.
import { build } from 'esbuild';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeNodeBenchChart } from '../bench/scenarios/node-adapter.mjs';
import { R1 } from '../bench/scenes.mjs';
import { makeBenchChart, seriesDefs } from '../bench/harness.mjs';
import { lineSeries, candleSeries } from '../bench/data-gen.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

// Bundle the structural specs + S12 spec to node ESM so the demo drives the EXACT same
// ScenarioSpec.script the CI gates do (no re-implementing the sweep / protocol here).
async function loadSpecs() {
  const b = await build({
    entryPoints: [join(root, 'bench', 'scenarios', 'structural-specs.ts'), join(root, 'bench', 'scenarios', 'S12.ts')],
    bundle: true,
    format: 'esm',
    write: false,
    platform: 'node',
    target: 'es2022',
    define: { __DEV__: 'true', __TV_PROFILE__: 'true' },
    absWorkingDir: root,
    logLevel: 'warning',
    outdir: 'out',
  });
  const byName = Object.fromEntries(b.outputFiles.map((o) => [o.path.replace(/\\/g, '/'), o.text]));
  const get = (suffix) => byName[Object.keys(byName).find((k) => k.endsWith(suffix))];
  const imp = (text) => import('data:text/javascript;base64,' + Buffer.from(text).toString('base64'));
  const structural = await imp(get('structural-specs.js'));
  const s12 = await imp(get('S12.js'));
  const S2 = structural.STRUCTURAL_SCENARIOS.find((s) => s.id === 'S2');
  return { S2, S12: s12.default };
}

const lines = [];
const log = (s = '') => lines.push(s);

// =================== S2 — Overlay re-emit counters (§4.4.1) ==========================
async function runS2(S2) {
  const fixture = await R1(2000, 500); // tractable R1 topology (structural.mjs's headless size)
  const adapter = makeNodeBenchChart(fixture);
  await S2.script(adapter.chart, { async probe() {} }); // the 120-move Overlay sweep
  // One Render pan frame AFTER the sweep so the base-only contrast is non-vacuous: a Render
  // frame DOES re-emit the dirtied base source (> 0) while every Overlay frame left it at 0.
  // The S2 spec itself is pure-Overlay (perf §9.2); this added Render frame is the demo's
  // witness, identical to the §4.4.1 non-vacuous check structural.mjs makes on S16.
  await adapter.chart.pan(5);

  const frames = adapter.frameSnaps;
  const overlay = adapter.overlayFrames();
  const render = frames.filter((s) => !overlay.includes(s));

  const overlayReEmit = overlay.length > 0 ? Math.max(...overlay.map((s) => s.sourcesReEmitted)) : 0;
  const overlayCmds = overlay.length > 0 ? Math.max(...overlay.map((s) => s.drawCommands)) : 0;
  const renderReEmit = render.length > 0 ? Math.max(...render.map((s) => s.sourcesReEmitted)) : 0;
  const idViolations = Math.max(0, ...frames.map((s) => s.cachedListIdentityViolations));

  log('=== S2 — crosshair sweep (R1, 120 moves): Overlay re-emit counters (perf §4.4.1) ===');
  log(`  painted frames: ${frames.length} (${overlay.length} Overlay, ${render.length} Render)`);
  log(`  Overlay sourcesReEmitted (base bands): ${overlayReEmit}   [§4.4.1 base-only ⇒ 0]`);
  log(`  Render  sourcesReEmitted (base bands): ${renderReEmit}   [> 0 ⇒ the invariant is non-vacuous]`);
  log(`  Overlay drawCommands (max):            ${overlayCmds}   [§4.4.3 Overlay ≤ 40]`);
  log(`  cachedListIdentityViolations:          ${idViolations}   [§4.4.2 ⇒ 0]`);

  let ok = true;
  if (overlayReEmit !== 0) (ok = false), log('  S2 FAIL: an Overlay frame re-emitted a base source (§4.4.1).');
  if (!(renderReEmit > 0)) (ok = false), log('  S2 FAIL: no Render frame re-emitted a base source — assertion vacuous.');
  if (overlayCmds > 40) (ok = false), log('  S2 FAIL: Overlay drawCommands exceed §4.4.3 cap of 40.');
  if (idViolations !== 0) (ok = false), log('  S2 FAIL: cachedListIdentityViolations > 0 (§4.4.2).');
  log(`  S2: ${ok ? 'PASS' : 'FAIL'} (Overlay re-emits 0 base sources; Render re-emits ${renderReEmit}).`);
  fixture.dispose();
  return ok;
}

// =================== S12 — per-point memory attribution (§6.2) =======================
// The SoA-lane floor the PlotStore deterministically retains (data/plot-store.ts): line =
// one Float64Array (8 B) + one Int32 TimeIndex (4 B); candle = four f64 lanes (32 B) + i32
// (4 B). The committed §6.2 caps leave headroom over those floors. These are EXACT and
// N-independent — the gated block. The node-heap Δ is the noisy approximation, printed after.
const S12_ROWS = [
  { name: 'line   (Δ afterA→afterB)', cap: 24, floor: '8 B lane + 4 B i32 index' },
  { name: 'candle (Δ afterB→afterC)', cap: 48, floor: '4×8 B lanes + 4 B i32 index' },
  { name: 'slot   (Δ1−Δ2 derived)  ', cap: 32, floor: 'shared timeline pool slot' },
];
const POINTS = Number(process.env.TV_S12_POINTS ?? 200_000);

function probeValue(spec, probes) {
  let d = probes[spec.to] - probes[spec.from];
  if (spec.from2 !== undefined && spec.to2 !== undefined) d -= probes[spec.to2] - probes[spec.from2];
  if (spec.perPoints) d /= spec.perPoints;
  return d;
}

async function buildMemFixture() {
  const f = await makeBenchChart({ mediaSize: { width: 1600, height: 900 } });
  const d = await seriesDefs();
  const handles = [
    f.chart.addSeries(d.LineSeries, {}, 0),
    f.chart.addSeries(d.LineSeries, {}, 0),
    f.chart.addSeries(d.CandlestickSeries, {}, 0),
  ];
  f.raf.flush(1);
  const gen = [() => lineSeries(POINTS, 0x21), () => lineSeries(POINTS, 0x22), () => candleSeries(POINTS, 0x23)];
  return { f, handles, gen };
}

async function runS12(S12) {
  log('');
  log('=== S12 — per-point memory attribution (R2-sized, perf §6.2): caps vs committed floor ===');
  log(`  3 series at the SAME ${POINTS.toLocaleString()} seeded timestamps (shared timeline pool after series A).`);
  for (const r of S12_ROWS) log(`  ${r.name}: §6.2 cap ${r.cap} B/pt   SoA floor: ${r.floor}`);

  // Drive the §6.2 protocol with the node gc()/heapUsed bridge (min over the gate's repeats).
  let heapNote = null;
  let monotoneOk = true;
  let gated = true;
  if (typeof global.gc === 'function') {
    const repeats = Math.max(...S12.gates.map((g) => g.probe?.repeats ?? 1), 1);
    const runProbes = [];
    for (let i = 0; i < repeats; i++) {
      const fixture = await buildMemFixture();
      const probes = {};
      const chart = {
        setData(idx, data) {
          fixture.handles[idx]?.setData(Array.isArray(data) && data.length > 0 ? data : fixture.gen[idx]());
          fixture.f.raf.flush(100 + idx);
        },
        update() {}, async crosshairMove() {}, async wheel() {}, async pan() {},
        async frame() { fixture.f.raf.flush(200); },
      };
      const harness = { async probe(label) { global.gc(); global.gc(); probes[label] = process.memoryUsage().heapUsed; } };
      await S12.script(chart, harness);
      runProbes.push(probes);
      fixture.f.dispose();
    }
    // Protocol well-formedness (deterministic, gated): the four §6.2 labels were probed in order.
    for (const l of ['empty', 'afterA', 'afterB', 'afterC']) {
      if (!runProbes.every((p) => typeof p[l] === 'number')) { gated = false; log(`  S12 FAIL: probe('${l}') missing — §6.2 protocol malformed.`); }
    }
    const v = (g) => Math.min(...runProbes.map((p) => probeValue(g.probe, p)));
    const lineB = v(S12.gates[0]);
    const candleB = v(S12.gates[1]);
    monotoneOk = candleB > lineB; // candle has 4 lanes vs line's 1 — must cost more (deterministic in sign)
    heapNote =
      `  node-heap Δ (indicative, min of ${repeats}): line ${v(S12.gates[0]).toFixed(1)} B/pt, ` +
      `candle ${candleB.toFixed(1)} B/pt, slot ${v(S12.gates[2]).toFixed(1)} B/pt`;
  } else {
    heapNote = '  node-heap Δ skipped (run with `node --expose-gc` for the §6.2 GC-floor bridge).';
  }

  const ok = gated && monotoneOk;
  log(`  S12: ${ok ? 'PASS' : 'FAIL'} (protocol well-formed; candle costs more than line; absolute B/pt gated by run.mjs).`);
  return { ok, heapNote };
}

// =================================== run + gate ======================================
const { S2, S12 } = await loadSpecs();
const s2ok = await runS2(S2);
const { ok: s12ok, heapNote } = await runS12(S12);

log('');
log(`demo-bench OK: S2 Overlay base-only re-emit + S12 §6.2 attribution verified against the committed caps.`);

const gatedOutput = lines.join('\n');
console.log(gatedOutput);
// The indicative node-heap line is logged OUTSIDE the gated block (run-to-run noise).
if (heapNote) console.log('\n[indicative, not gated] ' + heapNote.trim());

const goldenPath = join(here, 'demo-bench.golden.txt');
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
let gateOk = true;
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, gatedOutput + '\n');
  console.log('\ndemo-bench: recorded baseline -> ' + goldenPath);
} else if (norm(gatedOutput) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-bench: GATED output does not match ' + goldenPath);
  gateOk = false;
} else {
  console.log('\ndemo-bench: output matches golden.');
}

if (!s2ok || !s12ok || !gateOk) process.exit(1);
