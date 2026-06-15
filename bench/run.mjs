// bench/run.mjs — the Playwright frame-time runner (perf §9.1/§4.3). IMPLEMENTED but
// CI-GATED: it requires headless Chromium and is run only in the pinned CI job (perf §4.3
// "GitHub Actions standard 4-core runner class"). It is NOT executed in the dev/M10 gate
// set — the node-runnable structural/memory/microbench gates are (perf §9.1). If Chromium
// is missing it prints a clear message and exits 0, exactly like bench/conformance/run.mjs.
//
// What it does (per perf §4.3, normative for CI):
//   • launch pinned headless Chromium at deviceScaleFactor 2 (the §4.1 DPR);
//   • CDP Emulation.setCPUThrottlingRate(4) — the 4× throttle every budget is stated at;
//   • bundle the library (__TV_PROFILE__=true) + the browser scene/scenario driver to an
//     IIFE and inject it; the page builds a REAL canvasBackend() chart per scene and wires
//     an IPerfSink that pushes every FrameStats out to the runner;
//   • for each ScenarioSpec: run the script, collecting the FrameStats stream and (for
//     'probe' gates) bracketing CDP HeapProfiler.collectGarbage → Runtime.getHeapUsage
//     snapshots at each harness.probe(label);
//   • aggregate per gate (drop the first 10 warm-up frames; p95/avg/max/sum/exact for
//     'frame' gates; min-of-`repeats` GC-floor for 'probe' gates); run the WHOLE scenario
//     5× and take the median p95 (perf §4.3);
//   • evaluate each gate against its absolute cap (hard) AND drift vs bench/baselines.json
//     (warn > 10%, fail > driftFailPct ?? 20 — perf §9.5);
//   • write the freshly measured medians back out for `bench:rebaseline` (§9.5).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BASELINES = join(here, 'baselines.json');

const WARMUP_DROP = 10; // perf §4.3: drop the first 10 frames (JIT, high-water buffer growth)
const SCENARIO_RUNS = 5; // perf §4.3: run each scenario 5×, take the median p95
const DPR = 2; // perf §4.1: all scenes at DPR 2
const THROTTLE = 4; // perf §4.3: 4× CDP CPU throttle — the number every budget is stated at
const DRIFT_WARN_PCT = 10; // perf §9.5: warn > 10% drift
const REBASELINE = process.argv.includes('--rebaseline'); // §9.5 dedicated reviewed PR

function ciGatedExit(reason) {
  console.log(`bench/run: ${reason}`);
  console.log('bench/run: Chromium not installed — the frame-time runner is CI-gated. Skipped (exit 0).');
  process.exit(0);
}

// 1) Resolve Playwright + the browser executable; CI-gate out if missing (perf §9.1).
let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    ciGatedExit('playwright not resolvable');
  }
}
let execPath;
try {
  execPath = chromium.executablePath();
} catch {
  ciGatedExit('chromium.executablePath() unavailable');
}
if (!execPath || !existsSync(execPath)) ciGatedExit(`chromium executable not found at ${execPath ?? '(none)'}`);

// 2) Bundle the browser-side driver (real backend + scenes + the scenario catalog) to an
//    IIFE. __TV_PROFILE__=true wires the §9.6 counters; the driver exposes
//    window.__tvBench = { scenarios(), run(id, runIndex) } where run() drives the script,
//    streams FrameStats, and returns { frames, probes } for this run.
const { build } = await import('esbuild');
const bundle = await build({
  entryPoints: [join(here, 'browser', 'driver.ts')],
  bundle: true,
  format: 'iife',
  write: false,
  platform: 'browser',
  target: 'es2022',
  define: { __DEV__: 'false', __TV_PROFILE__: 'true' },
  absWorkingDir: root,
  logLevel: 'warning',
});
const driverJs = bundle.outputFiles[0].text;

// 3) Launch Chromium, throttle, inject the driver.
let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  ciGatedExit(`chromium.launch failed: ${(err && err.message) || err}`);
}
const page = await browser.newPage({ deviceScaleFactor: DPR });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await cdp.send('HeapProfiler.enable');
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: driverJs });

// The CDP heap probe the 'probe'-source gates ride (perf §5.3/§6.2): collectGarbage then
// read Runtime.getHeapUsage. The page pauses at each harness.probe(label) (it resolves a
// promise the runner awaits), the runner takes the snapshot, then releases the page.
async function heapUsedBytes() {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return usedSize;
}

// --- aggregation (perf §4.3) -----------------------------------------------------------
function p95(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))];
}
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// UpdateLevel.Layout (model/chart-model.ts: None 0 / Overlay 1 / Render 2 / Layout 3).
const LAYOUT_LEVEL = 3;
function reduceFrame(metric, aggregate, frames) {
  // layoutFrames is a DERIVED count, not a FrameStats lane: the number of Layout-level frames
  // over the run (the §4.4.6/§4.4.10 ≤ 2 Layout-frames cap, fix #3). No warm-up drop — a
  // structural count is exact every frame, so dropping frames would only hide a violation.
  if (metric === 'layoutFrames') {
    return frames.filter((f) => f.level === LAYOUT_LEVEL).length;
  }
  const xs = frames.slice(WARMUP_DROP).map((f) => f[metric]).filter((v) => v !== undefined);
  switch (aggregate) {
    case 'p95': return p95(xs);
    case 'avg': return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    case 'max': return xs.length ? Math.max(...xs) : 0;
    case 'sum': return xs.reduce((a, b) => a + b, 0);
    case 'exact': return xs.length ? Math.max(...xs) : 0; // exact gates assert a hard ceiling on every frame
    default: return 0;
  }
}
// A 'probe' gate's value: Δ (or derived Δ−Δ) ÷ perFrames/perPoints, min over `repeats` runs.
function reduceProbe(spec, runProbes) {
  const deltas = runProbes.map((p) => {
    let d = p[spec.to] - p[spec.from];
    if (spec.from2 !== undefined && spec.to2 !== undefined) d -= p[spec.to2] - p[spec.from2];
    if (spec.perFrames) d /= spec.perFrames;
    if (spec.perPoints) d /= spec.perPoints;
    return d;
  });
  return Math.min(...deltas); // the GC floor (perf §5.3/§6.2)
}

// --- run one scenario SCENARIO_RUNS× and reduce to one value per gate -------------------
async function runScenario(spec) {
  const probeRuns = []; // [{label: heapUsed}] one per repeat for probe gates
  const repeats = Math.max(...spec.gates.filter((g) => g.source === 'probe').map((g) => g.probe.repeats), 1);
  const needProbes = spec.gates.some((g) => g.source === 'probe');
  const runs = needProbes ? repeats : SCENARIO_RUNS;
  const frameMetricValues = {}; // metric+aggregate → [value per run] → median

  for (let r = 0; r < runs; r++) {
    // The page drives the script frame-by-frame; at each probe() it yields control so the
    // runner takes the CDP snapshot, then the page resumes.
    const probes = {};
    const frames = await page.evaluate(
      ({ id, runIndex }) => window.__tvBench.run(id, runIndex),
      { id: spec.id, runIndex: r },
    );
    // If the scenario declared probes, the driver recorded the label order; bracket each.
    if (needProbes) {
      const labels = await page.evaluate((id) => window.__tvBench.probeLabels(id), spec.id);
      for (const label of labels) probes[label] = await heapUsedBytes();
      probeRuns.push(probes);
    }
    for (const g of spec.gates) {
      if (g.source !== 'frame') continue;
      const key = `${g.metric}:${g.aggregate}`;
      (frameMetricValues[key] ??= []).push(reduceFrame(g.metric, g.aggregate, frames));
    }
  }

  const results = [];
  for (const g of spec.gates) {
    const value =
      g.source === 'probe'
        ? reduceProbe(g.probe, probeRuns)
        : median(frameMetricValues[`${g.metric}:${g.aggregate}`] ?? [0]);
    results.push({ gate: g, value });
  }
  return results;
}

// --- gate evaluation: absolute cap (hard) + baseline drift (perf §9.5) ------------------
const baselines = existsSync(BASELINES) ? JSON.parse(readFileSync(BASELINES, 'utf8')) : { scenarios: {} };
const freshBaseline = { $comment: baselines.$comment, runner: baselines.runner, scenarios: {} };

// The scenario catalog is TS (typed against gates.ts). Bundle it to node ESM so run.mjs
// reads its gate RECORDS as plain data; the browser driver bundles the same catalog for
// the scripts (the gates carry no DOM, the scripts run only in the page).
const catBundle = await build({
  entryPoints: [join(here, 'scenarios.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  target: 'es2022',
  define: { __DEV__: 'false', __TV_PROFILE__: 'true' },
  absWorkingDir: root,
  logLevel: 'warning',
});
const { SCENARIOS } = await import(
  'data:text/javascript;base64,' + Buffer.from(catBundle.outputFiles[0].text).toString('base64')
);
let failed = 0;

for (const spec of SCENARIOS) {
  const results = await runScenario(spec);
  freshBaseline.scenarios[spec.id] = {};
  for (const { gate, value } of results) {
    const key = `${gate.metric}:${gate.aggregate}`;
    freshBaseline.scenarios[spec.id][key] = round(value);

    // Informational-until-M11: REPORT, never gate. The value is vacuous in the M9 pipeline (a
    // lane reset before the synchronous data-work, a host source still stubbed to 0, …); print
    // the marker so the pass is not mistaken for a real bound. (perf §9.6 — keep the gate.)
    if (gate.informationalUntilM11 !== undefined) {
      console.log(`bench/run: [informational until M11: ${gate.informationalUntilM11}] ${spec.id} ${key} = ${round(value)} (cap ${gate.cap}) — reported, not gated`);
      continue;
    }

    // Hard absolute cap.
    const overCap = gate.aggregate === 'exact' ? value > gate.cap : value > gate.cap;
    if (overCap) {
      console.error(`bench/run: FAIL ${spec.id} ${key} = ${round(value)} > cap ${gate.cap}`);
      failed++;
      continue;
    }
    // Baseline drift (perf §9.5): warn > 10%, fail > driftFailPct ?? 20.
    const base = baselines.scenarios?.[spec.id]?.[key];
    if (base !== undefined && base > 0 && gate.aggregate !== 'exact') {
      const driftPct = ((value - base) / base) * 100;
      const failPct = gate.driftFailPct ?? 20;
      if (driftPct > failPct) {
        console.error(`bench/run: FAIL ${spec.id} ${key} drift +${driftPct.toFixed(1)}% > ${failPct}% (base ${base})`);
        failed++;
      } else if (driftPct > DRIFT_WARN_PCT) {
        console.warn(`bench/run: WARN ${spec.id} ${key} drift +${driftPct.toFixed(1)}% > ${DRIFT_WARN_PCT}% (base ${base})`);
      } else {
        console.log(`bench/run: PASS ${spec.id} ${key} = ${round(value)} (cap ${gate.cap}, base ${base})`);
      }
    } else {
      console.log(`bench/run: PASS ${spec.id} ${key} = ${round(value)} (cap ${gate.cap})`);
    }
  }
}

await browser.close();

if (REBASELINE) {
  writeFileSync(BASELINES, JSON.stringify(freshBaseline, null, 2) + '\n');
  console.log(`bench/run: rebaselined ${BASELINES} (§9.5 — commit with a rationale).`);
}

console.log(`bench/run: ${failed} gate failure(s).`);
process.exit(failed > 0 ? 1 : 0);

function round(v) { return Math.round(v * 1000) / 1000; }
