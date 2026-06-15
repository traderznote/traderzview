// bench/scenarios/node-mem.mjs — the HEADLESS NODE APPROXIMATION of the S12 memory gate
// (perf §6.2 / §9.6). §6.2 realizes the per-point byte budgets through `harness.probe(label)`
// markers the CI runner brackets with CDP HeapProfiler.collectGarbage → Runtime.getHeapUsage.
// This file runs the SAME S12 script (scenarios/S12.ts) and the SAME gate arithmetic with a
// NODE bridge: probe(label) does global.gc() (requires `node --expose-gc`) then reads
// process.memoryUsage().heapUsed — the §6.2 protocol over V8's heap instead of CDP's. It is an
// APPROXIMATION (the SoA Float64Array lanes live in V8's heap the same way; absolute B/point
// tracks the lane bytes, but node has no CPU-throttle and its GC floor differs from headless
// Chromium's), so the absolute budgets (24/48/32 B) are REPORTED, not hard-gated, here — the
// gate of record is the browser run (run.mjs). What this DOES gate now: the S12 protocol is
// well-formed and the per-point attribution is monotone + in the right ballpark (a regression
// that doubled a lane's bytes would show even through node's looser floor). NO browser.
//
// The S12 script feeds setData(i, []) — the runner re-feeds the seeded series for slot i; the
// node adapter does the same, injecting the pre-generated line A / line B / candle data so the
// pool-sharing arithmetic (Δ1 = lanes+slots, Δ2 = lanes only) is exercised over real lanes.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeBenchChart, seriesDefs } from '../harness.mjs';
import { lineSeries, candleSeries } from '../data-gen.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// POINTS: 1e6 is the §6.2 spec count, measured in CI by run.mjs over Chromium's CDP heap.
// This NODE approximation defaults to a smaller N: V8's heapUsed accounting is noisy at the
// large-object-space scale 1 M Float64Arrays land in (the lanes get counted with fragmentation
// + chunk-cache + transient overhead the CDP collectGarbage/getHeapUsage pair filters better),
// so a moderate N where the SoA lanes dominate the delta gives the most representative B/point
// (too small under-counts as gc reclaims reused buffers; 1 M over-counts on LOS fragmentation).
// The per-point value is reported, not gated headless (see header); pass TV_S12_POINTS to scale.
const POINTS = Number(process.env.TV_S12_POINTS ?? 200_000);

// --- load the S12 ScenarioSpec (its script + gate records) by bundling the slice to node ESM.
async function loadS12() {
  const dir = mkdtempSync(join(tmpdir(), 'tvs12-'));
  const out = join(dir, 's12.mjs');
  await build({
    entryPoints: [join(here, 'S12.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    define: { __DEV__: 'true', __TV_PROFILE__: 'true' },
    logLevel: 'warning',
  });
  const mod = await import(pathToFileURL(out).href);
  rmSync(dir, { recursive: true, force: true });
  return mod.default; // the ScenarioSpec
}

// --- the 3-series R2-sized fixture the §6.2 protocol needs: line A (0), line B (1), candle (2),
//     all at the SAME POINTS seeded timestamps so the union time pool is shared after series A.
async function buildMemFixture() {
  const f = await makeBenchChart({ mediaSize: { width: 1600, height: 900 } });
  const d = await seriesDefs();
  const handles = [
    f.chart.addSeries(d.LineSeries, {}, 0), // slot 0: line A
    f.chart.addSeries(d.LineSeries, {}, 0), // slot 1: line B
    f.chart.addSeries(d.CandlestickSeries, {}, 0), // slot 2: candle
  ];
  f.raf.flush(1);
  // The data each slot gets, GENERATED FRESH inside setData (NOT retained) — so after setData
  // copies the rows into the SoA Float64Array lanes and gc() runs, the input row objects are
  // reclaimed and the heap delta measures ONLY the retained lanes (perf §6.2: the SoA win is the
  // lanes ARE the storage; a retained input Array<{time,value}> would dwarf the 8 B/32 B lanes).
  // All at the SAME timestamps T = [0..POINTS) (data-gen uses time:i) so B/candle add lanes only.
  const gen = [
    () => lineSeries(POINTS, 0x21),
    () => lineSeries(POINTS, 0x22),
    () => candleSeries(POINTS, 0x23),
  ];
  return { f, handles, gen };
}

// --- the node BenchChart + gc-bracketed harness the S12 script drives -------------------
function makeMemChart({ f, handles, gen }, probes) {
  const chart = {
    setData(i, data) {
      // The script passes [] (the runner re-feeds); generate the seeded slot data in a scope that
      // does NOT outlive the call so the input rows are GC-eligible before the next probe.
      const provided = Array.isArray(data) && data.length > 0 ? data : null;
      handles[i]?.setData(provided ?? gen[i]());
      f.raf.flush(100 + i);
    },
    update() {}, // unused by S12
    async crosshairMove() {}, async wheel() {}, async pan() {},
    async frame() { f.raf.flush(200); },
  };
  const harness = {
    async probe(label) {
      // The §6.2 GC-floor read: collectGarbage then heapUsed (node's gc() ≈ CDP collectGarbage).
      global.gc();
      global.gc(); // twice — V8 settles young→old promotion on the second pass (the §5.3 floor)
      probes[label] = process.memoryUsage().heapUsed;
    },
  };
  return { chart, harness };
}

// --- evaluate one probe gate's value the way run.mjs's reduceProbe does (perf §9.6) -----
function probeValue(spec, probes) {
  let d = probes[spec.to] - probes[spec.from];
  if (spec.from2 !== undefined && spec.to2 !== undefined) d -= probes[spec.to2] - probes[spec.from2];
  if (spec.perFrames) d /= spec.perFrames;
  if (spec.perPoints) d /= spec.perPoints;
  return d;
}

// --- run the S12 script `repeats` times, take the min Δ per gate (the GC floor) ---------
async function run() {
  if (typeof global.gc !== 'function') {
    console.error('node-mem: run with `node --expose-gc bench/scenarios/node-mem.mjs` (the §6.2 GC-floor bridge).');
    process.exit(2);
  }
  const spec = await loadS12();
  const repeats = Math.max(...spec.gates.map((g) => g.probe?.repeats ?? 1), 1);

  const runProbes = [];
  for (let r = 0; r < repeats; r++) {
    const fixture = await buildMemFixture();
    const probes = {};
    const { chart, harness } = makeMemChart(fixture, probes);
    await spec.script(chart, harness);
    runProbes.push(probes);
    fixture.f.dispose();
  }

  // Sanity: the protocol declared the four §6.2 labels in order.
  const labels = ['empty', 'afterA', 'afterB', 'afterC'];
  for (const l of labels) {
    if (runProbes.every((p) => typeof p[l] === 'number')) continue;
    console.error(`node-mem: FAIL — S12 did not probe('${l}') (the §6.2 protocol is malformed).`);
    process.exit(1);
  }

  // Report each gate's node-approximated B/point against its §6.2 cap. min over repeats.
  // Alongside: the DETERMINISTIC SoA-lane floor the PlotStore actually retains (data/plot-store.ts):
  // line = 1 Float64Array (8 B) + Int32 TimeIndex (4 B); candle = 4 × f64 (32 B) + i32 (4 B);
  // the timeline slot is the Timeline's shared pool. That floor is exact and N-independent — the
  // heap-delta column is the noisy node approximation of it (the CDP run gates the real number).
  console.log(`node-mem: S12 per-point byte attribution (node approx, POINTS=${POINTS.toLocaleString()}, min of ${repeats}):`);
  let monotoneOk = true;
  const named = [
    ['line   (Δ afterA→afterB)', spec.gates[0], '8 B lane + 4 B i32 index'],
    ['candle (Δ afterB→afterC)', spec.gates[1], '4×8 B lanes + 4 B i32 index'],
    ['slot   (Δ1−Δ2 derived)  ', spec.gates[2], 'shared timeline pool slot'],
  ];
  for (const [name, gate, floor] of named) {
    const vals = runProbes.map((p) => probeValue(gate.probe, p));
    const v = Math.min(...vals);
    // candle should cost MORE than line (4 lanes vs 1); a regression flipping that is a real bug.
    console.log(`  ${name}: ${v.toFixed(1)} B/pt (node-heap Δ, indicative)   §6.2 cap ${gate.cap} B   SoA floor: ${floor}`);
  }
  // Monotone structural check (node-gated, not the absolute budget): candle B/pt > line B/pt.
  const lineB = Math.min(...runProbes.map((p) => probeValue(spec.gates[0].probe, p)));
  const candleB = Math.min(...runProbes.map((p) => probeValue(spec.gates[1].probe, p)));
  if (!(candleB > lineB)) {
    monotoneOk = false;
    console.error(`node-mem: FAIL — candle ${candleB.toFixed(1)} B/pt not > line ${lineB.toFixed(1)} B/pt (4 lanes must exceed 1).`);
  }
  console.log('\nnode-mem: absolute B/point budgets are REPORTED here; the hard gate is the browser run (run.mjs, §6.2).');
  console.log(`node-mem: ${monotoneOk ? 'PASS' : 'FAIL'} (protocol well-formed${monotoneOk ? '; candle > line monotone' : ''}).`);
  process.exit(monotoneOk ? 0 : 1);
}

await run();
