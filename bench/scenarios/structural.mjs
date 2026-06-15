// bench/scenarios/structural.mjs — the HEADLESS node runner for the §4.4 STRUCTURAL-invariant
// scenario slice (S2/S2b/S3/S8/S15/S16). It is the M10 acceptance for those scenarios' EXACT
// counter gates (perf §9.1): build each scene over the stub backend with __TV_PROFILE__=true
// (scenes.mjs → harness.mjs), drive its ScenarioSpec.script through the node BenchChart adapter
// (node-adapter.mjs), then evaluate each 'frame'-source gate against the per-frame FrameStats
// the host emitted — exactly as run.mjs's reduceFrame does in the browser, so the SAME gate
// records gate identically here and in CI. NO browser, NO Playwright, NO tsc -b.
//
// The full §9.2 catalog (bench/scenarios.ts) also carries p95 time + 'probe' heap gates; those
// need the throttled browser runner and are NOT evaluated here. structural-specs.ts isolates the
// exact-counter caps that gate NOW. A handful of caps depend on M11 features (R2 decimation for
// S8's ≤ 60; price-line/marker scene-source emit for S16's ≤ 220) — those are listed in
// INFORMATIONAL_UNTIL_M11 and REPORTED (not failed) with a log line, per the task.
//
// Run: node bench/scenarios/structural.mjs   (exit 1 on any gating failure).
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeNodeBenchChart } from './node-adapter.mjs';
import { R1, R2, R6 } from '../scenes.mjs';

// HEADLESS SCENE SIZES. The §4.4 structural COUNTS (drawCommands O(runs), identity violations,
// timeline rebuilds, the Overlay base-only cap) are point-count-INDEPENDENT by design — they pin
// the mechanism, not the data scale (perf §4.4 "immune to runner noise"). So the node runner
// builds the heavy scenes at a tractable size (the full 1 M-point R2 OOMs a headless node build
// of two timelines + stores; scenes.mjs's own §6.3 structural check uses R2(20000) for the same
// reason). The browser runner (run.mjs) builds the FULL §4.1 sizes for the TIMING gates. A
// smaller window still exercises every counter path the structural gates read.
const SCENE_BUILDERS = {
  R1: () => R1(2000, 500), // 2000 pts, 500 visible — full source topology, tractable lanes
  R2: () => R2(20_000), // decimated bulk at a tractable size (matches structural.mjs §6.3 check)
  R6: () => R6(2000, 500), // R1 topology + 100 price lines + marker requests
};
async function buildSceneHeadless(sceneId) {
  const b = SCENE_BUILDERS[sceneId];
  if (b === undefined) throw new Error(`structural runner has no headless size for scene ${sceneId}`);
  return b();
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

// Bundle the TS structural specs to node ESM so this runner reads the gate RECORDS as plain data
// (the gates are typed against gates.ts; the scripts carry no DOM and run only through the
// adapter). Same technique run.mjs uses for scenarios.ts. __TV_PROFILE__ value is irrelevant to
// the gate records themselves, but the define must be provided so the bundle type-checks/erases.
const catBundle = await build({
  entryPoints: [join(here, 'structural-specs.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  target: 'es2022',
  define: { __DEV__: 'false', __TV_PROFILE__: 'true' },
  absWorkingDir: root,
  logLevel: 'warning',
});
const { STRUCTURAL_SCENARIOS, INFORMATIONAL_UNTIL_M11 } = await import(
  'data:text/javascript;base64,' + Buffer.from(catBundle.outputFiles[0].text).toString('base64')
);

// NOTE (headless geometry, fix #8): the headless time-scale port is a stub (create-chart.ts —
// setVisibleLogicalRange/logicalToCoordinate are no-ops), so a series emits a MINIMAL command
// stream (a line is one polyline run). The §4.4.3 drawCommands MAX caps below (Overlay ≤ 40,
// R1 ≤ 120) therefore hold with large headroom and prove only the O(runs) SHAPE (not O(bars)),
// not the tight cap value — the non-vacuous command-count caps run in the Playwright runner
// (run.mjs, real geometry). The §4.4.1 base-only invariant IS non-vacuous here (Overlay re-emits
// 0 base sources WHILE Render frames re-emit > 0 — the witness contrast below).
console.log('structural-scenarios: [informational: headless time-scale geometry is degenerate — §4.4.3 drawCommands caps prove O(runs) shape only; the tight caps run in the Playwright runner]\n');

// --- per-gate frame-stream reducer (mirrors run.mjs reduceFrame; no WARMUP drop — structural
//     counts are exact every frame, so warm-up exclusion would only hide a violation) ---------
function reduceFrame(metric, aggregate, frames) {
  const xs = frames.map((f) => f[metric]).filter((v) => v !== undefined);
  if (xs.length === 0) return { value: 0, frames: 0 };
  switch (aggregate) {
    case 'max':
    case 'exact':
      return { value: Math.max(...xs), frames: xs.length }; // exact caps assert a per-frame ceiling
    case 'sum':
      return { value: xs.reduce((a, b) => a + b, 0), frames: xs.length };
    case 'avg':
      return { value: xs.reduce((a, b) => a + b, 0) / xs.length, frames: xs.length };
    case 'p95': {
      const s = [...xs].sort((a, b) => a - b);
      return { value: s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))], frames: xs.length };
    }
    default:
      return { value: 0, frames: xs.length };
  }
}

let failures = 0;
let informational = 0;

// Run one structural ScenarioSpec headless and evaluate its gates.
async function runScenario(spec) {
  const fixture = await buildSceneHeadless(spec.scene);
  const adapter = makeNodeBenchChart(fixture);

  // The harness: probe(label) is the inline declaration hook. Headless it is a no-op EXCEPT the
  // S2b 'listenerAttached' marker, which attaches one empty-body crosshairMove listener so the
  // lazy hasListeners() payload path (A3) runs during the sweep — proving it does not promote the
  // Overlay frame to touch base bands. (In the browser the runner brackets probes with CDP heap
  // snapshots; the node structural runner has no heap gates, so probe is otherwise a no-op.)
  const harness = {
    async probe(label) {
      if (label === 'listenerAttached' && typeof adapter.realChart.subscribeCrosshairMove === 'function') {
        adapter.realChart.subscribeCrosshairMove(() => {});
      }
    },
  };

  await spec.script(adapter.chart, harness);

  const frames = adapter.frameSnaps;
  const overlay = adapter.overlayFrames();
  const render = frames.filter((s) => !overlay.includes(s));

  console.log(`\nstructural ${spec.id} (${spec.scene}): ${frames.length} painted frame(s), ${overlay.length} overlay, ${render.length} render.`);

  // §4.4.1 base-only (S2/S2b/S16): an Overlay frame composites bands 6–8 ONLY, so it re-emits
  // ZERO base-band series sources. The exact proof, read off the counters: every Overlay frame's
  // sourcesReEmitted is 0 (no base series source was visited), WHILE the scene's Render frames DO
  // re-emit base sources (sourcesReEmitted > 0) — so the assertion is not vacuous. If a base
  // source leaked into the Overlay composite, the Overlay frame's sourcesReEmitted would be > 0.
  if (overlay.length > 0) {
    const maxOverlayReEmit = Math.max(...overlay.map((s) => s.sourcesReEmitted));
    const maxOverlayCmds = Math.max(...overlay.map((s) => s.drawCommands));
    const renderReEmit = render.length > 0 ? Math.max(...render.map((s) => s.sourcesReEmitted)) : 0;
    const baseLeak = maxOverlayReEmit > 0 || maxOverlayCmds > 40;
    if (baseLeak) {
      console.error(`structural ${spec.id}: FAIL §4.4.1 base-only — an Overlay frame re-emitted ${maxOverlayReEmit} source(s) / ${maxOverlayCmds} cmds (> 0 base ⇒ a base source was composited at Overlay scope)`);
      failures++;
    } else {
      const witness = render.length > 0 ? ` (Render frames re-emit ${renderReEmit} base source(s) — assertion non-vacuous)` : '';
      console.log(`structural ${spec.id}: PASS §4.4.1 base-only (Overlay sourcesReEmitted 0, drawCommands ${maxOverlayCmds} ≤ 40)${witness}`);
    }
  }

  const infoReasons = INFORMATIONAL_UNTIL_M11[spec.id] ?? {};
  for (const g of spec.gates) {
    if (g.source !== 'frame') continue; // probe/wall gates are browser-only — not in this slice
    const key = `${g.metric}:${g.aggregate}`;
    const { value, frames: n } = reduceFrame(g.metric, g.aggregate, frames);
    const over = value > g.cap;
    const reason = infoReasons[key];
    if (reason !== undefined) {
      // Informational-until-M11: NEVER a hard pass (vacuous until the M11 feature lands), NEVER a
      // hard fail. Print the explicit marker so the pass is not mistaken for a real bound.
      const rel = over ? `> cap ${g.cap}` : `≤ cap ${g.cap} (not yet meaningful)`;
      console.log(`structural ${spec.id}: [informational until M11: ${reason}] ${key} = ${value} ${rel} over ${n} frame(s) — reported, not gated`);
      informational++;
    } else if (over) {
      console.error(`structural ${spec.id}: FAIL ${key} = ${value} > cap ${g.cap} over ${n} frame(s)`);
      failures++;
    } else {
      console.log(`structural ${spec.id}: PASS ${key} = ${value} ≤ ${g.cap} over ${n} frame(s)`);
    }
  }

  // §4.4.5 coalescing (S15): every frame() that armed work paints exactly one frame; the 84
  // appends per turn merge into ONE pending mask. The adapter only records a snapFrame per ACTUAL
  // painted frame, so for S15 the painted-frame count must equal the number of frame() turns (60).
  if (spec.id === 'S15') {
    const ok = frames.length === 60;
    if (ok) {
      console.log(`structural S15: PASS §4.4.5 coalescing — 84 appends/turn coalesced to exactly 1 painted frame × 60 turns`);
    } else {
      console.error(`structural S15: FAIL §4.4.5 coalescing — ${frames.length} painted frames for 60 turns (expected 1/turn)`);
      failures++;
    }
  }

  fixture.dispose();
}

for (const spec of STRUCTURAL_SCENARIOS) {
  try {
    await runScenario(spec);
  } catch (err) {
    console.error(`structural ${spec.id}: ERROR ${(err && err.stack) || err}`);
    failures++;
  }
}

console.log(`\nstructural-scenarios: ${failures} gating failure(s), ${informational} informational-until-M11 report(s).`);
process.exit(failures > 0 ? 1 : 0);
