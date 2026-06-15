// bench/harness.mjs — the HEADLESS stub-backend chart harness the node-runnable scenes
// build on (reused from scripts/demo-chart.mjs). NO browser, NO real canvas: a recording
// ISurface per surface, a fake rAF scheduler the scene driver flushes by hand, and a fake
// DOM element tree (only the methods createChartWith + ChartHost touch). The library is
// bundled from TS via esbuild with __TV_PROFILE__=true so the perf §9.6 counters are wired
// and a scene can read frameCounters off the chart for the exact STRUCTURAL-invariant
// gates (S2/S2b/S3/S8/S15/S16 — runner-noise-immune, like scripts/demo-chart.mjs).
//
// The Playwright runner (run.mjs) builds a DIFFERENT, real-DOM chart in a browser page;
// this harness is only for the node-gated structural/memory/microbench pieces (§9.1).
//
// makeBenchChart(env) returns the BenchChart the ScenarioSpec.script receives:
//   { chart, counters, sink, frames, raf, backendLog, mediaSize, dispose }
// where `counters` is the live FrameCounters (read AFTER a flush for §4.4 counts),
// `frames` is the FrameStats[] the IPerfSink collected, and `raf.flush(now)` drives the
// single pending frame the model armed (the scene calls it after each interaction).
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Repo root, anchored to THIS file's location (not process.cwd()) so the bundle resolves
// `./src/...` against the repo root no matter which directory the node gate is invoked from
// (fix #2 — mirrors scripts/demo-bench.mjs / bench/run.mjs / bench/micro/goldens.mjs).
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// One bundle of the library entry the harness drives — built once, imported by every
// scene in a run. __TV_PROFILE__=true turns the §9.6 counter wiring ON (the shipped build
// strips it; the bench build keeps it — that asymmetry is the whole point of the define).
let libModulePromise = null;

function libSource() {
  return `
    export { createChartWith, LineSeries, AreaSeries, BaselineSeries, BarSeries,
             CandlestickSeries, HistogramSeries } from './src/api/index';
    export { timeBehavior } from './src/data/index';
    export { createFrameCounters } from './src/core/index';
  `;
}

async function lib() {
  if (libModulePromise === null) {
    libModulePromise = (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tvbench-'));
      const out = join(dir, 'lib.mjs');
      await build({
        stdin: { contents: libSource(), resolveDir: ROOT, loader: 'ts', sourcefile: 'bench-lib.ts' },
        outfile: out,
        bundle: true,
        format: 'esm',
        platform: 'node',
        // The bench build: dev asserts ON, and — unlike the shipped build — the §9.6
        // profiling counters COMPILED IN so scenes can read them (perf §9.1/§3.3.1).
        define: { __DEV__: 'true', __TV_PROFILE__: 'true' },
        logLevel: 'warning',
      });
      const mod = await import(pathToFileURL(out).href);
      rmSync(dir, { recursive: true, force: true });
      return mod;
    })();
  }
  return libModulePromise;
}

// --- recording stub backend (one ISurface per createSurface; records the §6 sequence) ---
function makeBackend(log) {
  let seq = 0;
  const makeSurface = () => {
    const name = 'surf' + seq++;
    let media = { width: 0, height: 0 };
    return {
      setMediaSize(s) { media = s; },
      beginFrame(scope) {
        log.push({ surface: name, op: 'begin', scope });
        return { mediaSize: media, bitmapSize: { width: media.width, height: media.height }, hr: 1, vr: 1 };
      },
      renderLayer(layer, lists) {
        let cmds = 0;
        for (const l of lists) cmds += l.commands.length;
        log.push({ surface: name, op: 'render', layer, lists: lists.length, cmds });
      },
      endFrame() { log.push({ surface: name, op: 'end' }); },
      resolutionChanged: { subscribe() { return () => {}; } },
      snapshot() { return { _tag: 'SurfaceSnapshot' }; },
      dispose() { log.push({ surface: name, op: 'dispose' }); },
    };
  };
  return {
    createSurface() { return makeSurface(); },
    createImage() { return { id: 0, width: 0, height: 0 }; },
    composeSnapshot() { return { _tag: 'Snapshot' }; },
    text: { measure: (t) => ({ width: 6 * String(t.text ?? t).length, ascent: 8, descent: 2 }) },
    dispose() {},
  };
}

// --- fake single-slot rAF scheduler (the scene flushes the one pending frame by hand) ---
function makeRaf() {
  let pending = null;
  let now = 0;
  return {
    scheduler: {
      schedule(cb) { pending = cb; return () => { if (pending === cb) pending = null; }; },
      dispose() { pending = null; },
    },
    hasPending() { return pending !== null; },
    flush(t) { const cb = pending; pending = null; if (cb !== null) cb(t ?? now++); },
  };
}

// --- fake DOM element tree (only what createChartWith + ChartHost call) ------------------
function makeElement(doc, size) {
  const children = [];
  return {
    ownerDocument: doc,
    style: {},
    children,
    appendChild(c) { children.push(c); return c; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; },
    contains(c) { return children.includes(c); },
    getBoundingClientRect() { return { left: 0, top: 0, width: size.width, height: size.height }; },
  };
}
function makeDoc(size) { const doc = { createElement() { return makeElement(doc, size); } }; return doc; }

/**
 * Build one headless BenchChart. `env` = { mediaSize?, options? }.
 * Returns the fixture object scene scripts drive. The chart is painted once (the
 * synchronous initial Layout flush) before return; the scene then mutates + flushes.
 */
export async function makeBenchChart(env = {}) {
  const mediaSize = env.mediaSize ?? { width: 1600, height: 900 };
  const { createChartWith, timeBehavior, createFrameCounters } = await lib();

  const backendLog = [];
  const backend = makeBackend(backendLog);
  const raf = makeRaf();
  const doc = makeDoc(mediaSize);
  const container = makeElement(doc, mediaSize);

  const counters = createFrameCounters();
  const frames = [];
  const sink = { onFrame: (stats) => frames.push(stats) };

  const chart = createChartWith(
    container,
    backend,
    timeBehavior(),
    { width: mediaSize.width, height: mediaSize.height, ...(env.options ?? {}) },
    { scheduler: raf.scheduler, perfSink: sink, frameCounters: counters },
  );
  raf.flush(0); // drain the frame armed by the initial synchronous setSize()

  return {
    chart,
    counters,            // the live FrameCounters — read after a flush for §4.4 counts
    frames,              // FrameStats[] the IPerfSink collected
    sink,
    raf,                 // raf.flush(now) drives the one pending frame
    backendLog,          // [{surface, op, ...}] — the §6 call stream
    mediaSize,
    dispose() { chart.dispose(); },
  };
}

/** A lib accessor for scenes that need the series-definition tokens (LineSeries, …). */
export async function seriesDefs() {
  const m = await lib();
  return {
    LineSeries: m.LineSeries, AreaSeries: m.AreaSeries, BaselineSeries: m.BaselineSeries,
    BarSeries: m.BarSeries, CandlestickSeries: m.CandlestickSeries, HistogramSeries: m.HistogramSeries,
  };
}
