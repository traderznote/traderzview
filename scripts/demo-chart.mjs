// M9 demo (roadmap §M9) — the HEADLESS proof the public API join point is correct with
// NO browser and NO concrete backend. It runs the design 02 §2 quickstart through
// createChartWith over an INJECTED stub IRenderBackend (an ISurface per surface that
// records beginFrame/renderLayer/endFrame), a FAKE container element (only the DOM
// methods createChartWith + ChartHost actually call), a fake ownerDocument, and a fake
// rAF scheduler (env.scheduler) — then drives:
//   createChart → addSeries(CandlestickSeries) → setData → subscribeCrosshairMove →
//   setCrosshairPosition (the §7 sync seam that fires the hub) → fitContent, and asserts
//   the recorded backend call sequence is non-empty + well-formed (begin → renderLayer
//   base|overlay → end per §6) and that the crosshair MouseEventParams has the §14.2
//   shape; then dispose() (idempotent, frees listeners, §16.5-guards later calls).
// Bundled from TS via esbuild (stdin loader 'ts') like the sibling demos and gated vs
// scripts/demo-chart.golden.txt (record-then-gate; structural invariants asserted INSIDE
// render() so a regression fails even if re-recorded).
// FOLLOW-UP: the browser Playwright screenshot e2e scripts/demo-chart.html is CI-gated
// (mirrors M6/M7/M8) and out of scope here.
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demoSource = `
import { createChartWith, CandlestickSeries } from './src/api/index';
import { timeBehavior } from './src/data/index';

const assert = (cond, msg) => { if (!cond) throw new Error('demo-chart assert: ' + msg); };

// --- stub IRenderBackend: one recording ISurface per createSurface. Records the §6
//     begin/render/end sequence into a shared log. NO pixels, NO real canvas. ---------
function makeBackend(log) {
  let seq = 0;
  const makeSurface = () => {
    const name = 'surf' + seq++;
    let media = { width: 0, height: 0 };
    return {
      setMediaSize(s) { media = s; },
      beginFrame(scope) {
        log.push(name + '.beginFrame ' + scope);
        return { mediaSize: media, bitmapSize: { width: media.width, height: media.height }, hr: 1, vr: 1 };
      },
      renderLayer(layer, lists) {
        let cmds = 0;
        for (const l of lists) cmds += l.commands.length;
        log.push(name + '.renderLayer ' + layer + ' lists=' + lists.length + ' cmds=' + cmds);
      },
      endFrame() { log.push(name + '.endFrame'); },
      resolutionChanged: { subscribe() { return () => {}; } },
      snapshot() { return { _tag: 'SurfaceSnapshot' }; },
      dispose() { log.push(name + '.dispose'); },
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

// --- fake rAF scheduler (single-slot test driver, like demo-host). Injected via
//     env.scheduler so the per-chart createRafScheduler (window.rAF) NEVER runs. ------
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

// --- fake element tree: the container + every child div the host/api create. Tracks
//     parent/child membership for contains()/removeChild(). getBoundingClientRect gives
//     the initial outer size; the backend log is the proof, so it records nothing. ----
function makeElement(doc) {
  const children = [];
  const el = {
    ownerDocument: doc,
    style: {},
    children,
    appendChild(c) { children.push(c); return c; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; },
    contains(c) { return children.includes(c); },
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 400 }; },
  };
  return el;
}
function makeDoc() { const doc = { createElement() { return makeElement(doc); } }; return doc; }

export function render() {
  const lines = [];
  const log = [];
  const backend = makeBackend(log);
  const raf = makeRaf();
  const doc = makeDoc();
  const container = makeElement(doc);

  // === design 02 §2 quickstart through the explicit factory ==========================
  lines.push('=== createChartWith (stub backend + fake container + fake rAF) ===');
  const chart = createChartWith(
    container, backend, timeBehavior(),
    { layout: { textColor: '#191919' } }, { scheduler: raf.scheduler },
  );
  raf.flush(0); // drain any frame armed after the synchronous initial setSize() flush
  const afterCreate = log.length;
  assert(afterCreate > 0, 'construction paints at least one frame to the backend');
  lines.push('  backend calls after create: ' + afterCreate);
  const generatedDiv = container.children[0];
  assert(chart.element() === generatedDiv, 'chart.element() is the generated container div');

  // === addSeries(CandlestickSeries) — the §13.2 definition pair ======================
  lines.push('');
  lines.push('=== addSeries(CandlestickSeries) → setData → render ===');
  const candles = chart.addSeries(CandlestickSeries, { upColor: '#26a69a' });
  assert(candles.seriesType() === 'candlestick', 'series handle reports its type');
  assert(chart.panes()[0] === chart.panes()[0], 'pane handle identity is cached (§2)');
  assert(chart.timeScale() === chart.timeScale(), 'time-scale handle is a cached singleton (§2)');

  const before = log.length;
  candles.setData([
    { time: '2026-01-05', open: 10, high: 14, low: 9, close: 13 },
    { time: '2026-01-06', open: 13, high: 17, low: 12, close: 11 },
    { time: '2026-01-07', open: 11, high: 12, low: 8, close: 9 },
    { time: '2026-01-08', open: 9, high: 15, low: 9, close: 14 },
    { time: '2026-01-09', open: 14, high: 16, low: 13, close: 15 },
  ]);
  raf.flush(16); // the Render frame setData armed
  const renderCalls = log.slice(before);
  printLog(lines, renderCalls);
  // §6: a Render frame is beginFrame('full') → renderLayer('base') → renderLayer('overlay') → end.
  assert(renderCalls.some((l) => l.includes('.beginFrame full')), 'setData drives a full (base+overlay) frame');
  assert(renderCalls.some((l) => l.includes('.renderLayer base')), 'the base layer (the series scene) is rendered');
  assertBalanced(renderCalls); // every beginFrame matched by an endFrame on the same surface
  assert(
    renderCalls.some((l) => l.includes('.renderLayer base') && !l.endsWith('cmds=0')),
    'the candlestick series emitted a non-empty draw-command stream',
  );

  // === subscribeCrosshairMove + setCrosshairPosition — the §14.2 payload (§7 sync seam)
  lines.push('');
  lines.push('=== subscribeCrosshairMove ← setCrosshairPosition payload (§7/§14.2) ===');
  let received = null;
  const off = chart.subscribeCrosshairMove((p) => { received = p; });
  chart.setCrosshairPosition(9, '2026-01-07', candles); // full form: price + series (§7)
  assert(received !== null, 'the crosshair handler received a payload');
  assert(typeof received.paneIndex === 'number', 'payload carries paneIndex (§14.2)');
  assert(received.seriesData instanceof Map, 'payload.seriesData is a Map keyed by handles (§14.2)');
  assert(received.seriesData.get(candles) !== undefined, 'seriesData is keyed by the USER handle (§14.2)');
  lines.push('  payload: time=' + received.time + ' paneIndex=' + received.paneIndex +
    ' seriesData.size=' + received.seriesData.size);
  off();
  received = null;
  chart.setCrosshairPosition(9, '2026-01-07', candles);
  assert(received === null, 'unsubscribe() stops delivery (§14.1)');

  // === fitContent — a navigation call that drives a frame without erroring ===========
  lines.push('');
  lines.push('=== fitContent() ===');
  const beforeFit = log.length;
  chart.timeScale().fitContent();
  raf.flush(32);
  lines.push('  backend calls from fitContent: ' + (log.length - beforeFit));

  // === dispose() — idempotent, frees listeners, throws on later use (§16.5) ==========
  lines.push('');
  lines.push('=== dispose() (idempotent; §16.5 disposed-guard) ===');
  chart.dispose();
  const disposed = log.filter((l) => l.endsWith('.dispose')).length;
  lines.push('  surfaces disposed: ' + disposed);
  assert(disposed > 0, 'dispose tears down every surface');
  chart.dispose(); // idempotent — no throw
  let guarded = false;
  try { chart.addSeries(CandlestickSeries); } catch (e) { guarded = e && e.code === 'disposed'; }
  assert(guarded, 'every method throws ChartError(disposed) after dispose (§16.5)');
  assert(!container.contains(generatedDiv), 'the generated div is detached on dispose');

  lines.push('');
  lines.push('demo-chart OK: createChartWith join → addSeries/setData drove a well-formed §6 backend stream; crosshair payload §14.2; dispose idempotent + guarded.');
  return lines;
}

function printLog(lines, log) { for (const l of log) lines.push('  ' + l); }

// Assert every beginFrame on a surface is matched by an endFrame on that surface.
function assertBalanced(log) {
  const open = new Map();
  for (const l of log) {
    const b = l.match(/^(\\S+)\\.beginFrame/);
    const e = l.match(/^(\\S+)\\.endFrame/);
    if (b) open.set(b[1], (open.get(b[1]) ?? 0) + 1);
    if (e) open.set(e[1], (open.get(e[1]) ?? 0) - 1);
  }
  for (const [, n] of open) if (n !== 0) throw new Error('demo-chart assert: unbalanced begin/endFrame');
}
`;

const dir = mkdtempSync(join(tmpdir(), 'tvdemo-'));
const out = join(dir, 'demo.mjs');
await build({
  stdin: { contents: demoSource, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'demo-chart.ts' },
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  define: { __DEV__: 'true', __TV_PROFILE__: 'false' },
  logLevel: 'warning',
});
const { render } = await import(pathToFileURL(out).href);
const output = render().join('\n');
rmSync(dir, { recursive: true, force: true });

console.log(output);

const goldenPath = 'scripts/demo-chart.golden.txt';
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, output + '\n');
  console.log('\ndemo-chart: recorded baseline -> ' + goldenPath);
} else if (norm(output) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-chart: STDOUT does not match ' + goldenPath);
  process.exit(1);
} else {
  console.log('\ndemo-chart: output matches golden.');
}
