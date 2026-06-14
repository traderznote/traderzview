// M7 demo (roadmap §M7(e)) — the HEADLESS proof the views module is correct with no
// DOM and no backend. Feeds an M5 HorzGeometry + a fake PriceConverter + an M4-style
// SoA store into all six built-in series kinds (line/area/baseline/histogram/bar/
// candlestick) plus a grid + a crosshair source, registers each as a SceneSource in a
// PaneScene, composites BOTH layers (base bands 0–5, overlay 6–8), and prints the flat
// draw-command stream, one hitTest query, and the price/time axis-layout widths. Like
// the sibling demos it is bundled from TS via esbuild (stdin loader 'ts') and gated
// against scripts/demo-views.golden.txt (record-then-gate); the structural invariants
// (command counts, list spaces, vertex/run sums) are asserted INSIDE render() so a
// regression fails even if the golden were re-recorded.
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demoSource = `
import {
  createLineKind,
  createAreaKind,
  createBaselineKind,
  createHistogramKind,
  createBarKind,
  createCandlestickKind,
  createGridSource,
  createCrosshairSource,
  PaneScene,
  hitTestPane,
  layoutPriceAxis,
  layoutTimeAxis,
  itemWindow,
} from './src/views/index';
import { DisplayListBuilder, ZBand } from './src/gfx/index';
import { createHorzGeometry, Crosshair, CrosshairMode } from './src/model/index';

const assert = (cond, msg) => { if (!cond) throw new Error('demo-views assert: ' + msg); };

// --- fakes (mirror src/views/series/line.test.ts so the math is the spec's) -------

// Single-value SoA store: timeIndex(i)===i so rows map left→right through horz; for
// the OHLC kinds lane(0)=open, max/min are the hi/lo roles, current=close.
function makeStore(rows) {
  const n = rows.length;
  return {
    length: n,
    timeIndex: (i) => i,
    current: (i) => rows[i].c,
    min: (i) => rows[i].l,
    max: (i) => rows[i].h,
    lane: (_n, i) => rows[i].o,
    firstIndexAt: () => null,
    nearestIndexAt: () => -1,
  };
}

// createHorzGeometry({ width:100, barSpacing:10, rightOffset:0, baseIndex:3 }):
//   indexToCoordinate: ix 0→64, 1→74, 2→84, 3→94 (media-px centres).
function makeHorz(barSpacing) {
  return createHorzGeometry({ width: 100, barSpacing, rightOffset: 0, baseIndex: 3 });
}
// priceToCoordinate(price) = 200 − price (larger price → smaller/top Y). NaN→NaN.
const fakePrice = {
  priceToCoordinate: (p) => 200 - p,
  firstValue: null,
  mode: 'normal',
  toLogical: (p) => p,
};
// hr=vr=2 → bitmap = media·2 (mirrors line.test.ts).
function frame(hr = 2, vr = 2) {
  return {
    frame: { mediaSize: { width: 100, height: 100 }, bitmapSize: { width: 100 * hr, height: 100 * vr }, hr, vr },
    now: 0,
  };
}
// A deterministic monospace measurer: width = 6·len, ascent 8, descent 2.
const measurer = { measure: (t) => ({ width: 6 * t.length, ascent: 8, descent: 2 }) };

// --- a tiny SceneSource adapter for a SeriesKind (lives in the demo, NOT the lib) -
// The engine pairs a kind with its reusable buffer + window; this wrapper drives the
// normal path (itemsFromStore → convert → emit) into one DisplayListBuilder and caches
// the lists with the per-source identity discipline (perf §4.4.2 / pane-scene.ts).
function seriesSource(kind, store, horz, win, buffer, zBand = ZBand.Series) {
  // line/baseline/histogram/bar/candlestick expose createBuffer(); area returns its
  // buffer alongside the kind (createAreaKind() → { kind, buffer }), passed in here.
  const buf = buffer ?? kind.createBuffer();
  kind.itemsFromStore(store, { kind: 'replace' }, buf);
  const builder = new DisplayListBuilder();
  let cached = null;
  return {
    buf,
    kind,
    zBand,
    update(f) {
      if (cached !== null) return; // single rebuild then clean (geometry is static here)
      kind.convert(buf, win, f, horz, fakePrice);
      builder.reset();
      kind.emit(buf, win, f, builder);
      cached = builder.finish();
    },
    displayLists() {
      return cached ?? [];
    },
    hitTest(x, y) {
      return kind.hitTest(buf, x, y);
    },
  };
}

// Count vertices/quads carried by a command (the structural sum the gate checks).
// gfx command shapes (commands.ts §3): polyline/area carry points (2·N), rects carry
// coords (4·N quads), circles carry coords (3·N), text carries items.
function commandSize(c) {
  if (c.kind === 'polyline') return c.points.length / 2;
  if (c.kind === 'area') return c.points.length / 2;
  if (c.kind === 'rects') return c.coords.length / 4;
  if (c.kind === 'circles') return c.coords.length / 3;
  if (c.kind === 'text') return c.items.length;
  return 0;
}

export function render() {
  const lines = [];
  const f = frame();
  const horz = makeHorz(10);
  // Five rows; OHLC roles let bar/candlestick read open/high/low/close, the single-
  // value kinds read close. A clear up/down mix so colours split.
  const rows = [
    { o: 10, h: 14, l: 9, c: 13 },
    { o: 13, h: 17, l: 12, c: 11 },
    { o: 11, h: 12, l: 8, c: 9 },
    { o: 9, h: 15, l: 9, c: 14 },
    { o: 14, h: 16, l: 13, c: 15 },
  ];
  const store = makeStore(rows);
  const win = itemWindow(0, rows.length);

  // --- the six kinds, each its own SceneSource in band Series -----------------
  // area returns { kind, buffer }; the other five expose createBuffer(). Each entry
  // is [name, kind, buffer?] — buffer present only for area.
  const area = createAreaKind();
  const kinds = [
    ['line', createLineKind({})],
    ['area', area.kind, area.buffer],
    ['baseline', createBaselineKind({ baseValue: { price: 12 } })],
    ['histogram', createHistogramKind({ base: 0 })],
    ['bar', createBarKind({})],
    ['candlestick', createCandlestickKind({})],
  ];
  const sources = kinds.map(([, k, b]) => seriesSource(k, store, horz, win, b));

  // --- grid (band Grid) + crosshair (band Crosshair → overlay layer) ----------
  const grid = createGridSource({
    vertLines: { color: '#e0e0e0', visible: true },
    horzLines: { color: '#e0e0e0', visible: true },
  });
  // tick X (time) at the bar centres; tick Y (price) via fakePrice on 10/12/14.
  grid.setTicks([64, 74, 84, 94], [200 - 10, 200 - 12, 200 - 14]);

  const ch = new Crosshair();
  ch.setMode(CrosshairMode.Normal);
  ch.setPosition({ index: 1, price: 13, x: 74, y: 187, originX: 74, originY: 187 });
  const crosshair = createCrosshairSource(ch);

  // --- register everything into ONE PaneScene (architecture §6) ---------------
  const scene = new PaneScene();
  sources.forEach((s, i) => scene.register(s, { ownerZ: i, ownerId: i }));
  scene.register(grid, { ownerZ: 0, ownerId: 100 });
  scene.register(crosshair, { ownerZ: 0, ownerId: 101 });
  assert(scene.size() === sources.length + 2, 'scene registered 8 sources');

  // --- composite BOTH layers (base bands 0–5, overlay 6–8) --------------------
  // composite() returns a REUSED scratch array (pane-scene.ts: "valid until the next
  // composite of either layer"), so snapshot the base lists before compositing overlay.
  const base = [...scene.composite('base', f)];
  lines.push('=== composite BASE layer (bands 0–5: grid + series) ===');
  printLayer(lines, base);
  // Grid (band 1) sorts before the six series (band 3); the crosshair (band 6) is
  // NOT in the base layer.
  assert(base[0].space === 'bitmap', 'first base list is the grid (bitmap)');

  const overlay = [...scene.composite('overlay', f)];
  lines.push('');
  lines.push('=== composite OVERLAY layer (bands 6–8: crosshair) ===');
  printLayer(lines, overlay);
  // §4.4.1: an overlay composite re-emits ZERO base-band sources.
  assert(scene.sourcesReEmitted <= 1, 'overlay composite re-emits at most the crosshair');

  // total flat command stream across both layers.
  const allLists = [...base, ...overlay];
  let totalCmds = 0;
  let totalSize = 0;
  const spaces = { media: 0, bitmap: 0 };
  for (const l of allLists) {
    spaces[l.space]++;
    for (const c of l.commands) {
      totalCmds++;
      totalSize += commandSize(c);
    }
  }
  lines.push('');
  lines.push('flat stream: lists=' + allLists.length + ' (media=' + spaces.media + ' bitmap=' + spaces.bitmap + ')');
  lines.push('  commands=' + totalCmds + ' vertex/quad/text-sum=' + totalSize);
  assert(allLists.length === base.length + overlay.length, 'flat stream is base ++ overlay');

  // --- one hitTest query: the engine-level kind.hitTest over the converted slice
  // pointer at the bar-1 centre (media x=74), y near close=11 → media y=200−11=189.
  lines.push('');
  lines.push('=== hitTest @ media (74, 189) — per-kind engine hitTest ===');
  for (let i = 0; i < kinds.length; i++) {
    const [name] = kinds[i];
    const hit = sources[i].hitTest(74, 189);
    lines.push('  ' + pad(name, 12) + (hit === null ? 'miss' : 'hit  dist=' + fmt(hit.distance) + ' prio=' + hit.priority));
  }
  // line/area/baseline are line-like (a point near the polyline hits); bar/candle/
  // histogram are columns straddling the value → all six should register a hit here.
  const lineHit = sources[0].hitTest(74, 189);
  assert(lineHit !== null && lineHit.distance <= 3, 'line kind hits within tolerance at the bar centre');

  // --- the ranked hit-test SERVICE over the SceneSource hitTest (crosshair off) -
  // Only sources that expose a SceneSource.hitTest(x,y,frame) participate; our series
  // adapters expose the 2-arg engine signature, so we wrap them for the service.
  const hitSources = sources.map((s, i) => ({
    source: { zBand: s.zBand, update() {}, displayLists: () => [], hitTest: (x, y) => s.hitTest(x, y) },
    sourceId: kinds[i][0],
  }));
  const ranked = hitTestPane(hitSources, 74, 189, f);
  lines.push('');
  lines.push('=== hitTestPane ranked (winner first) ===');
  lines.push('  hits=' + ranked.ranked.length + ' winner=' + (ranked.target ? ranked.target.sourceId : 'none'));
  for (const r of ranked.ranked) lines.push('    ' + pad(r.sourceId, 12) + 'dist=' + fmt(r.candidate.distance) + ' prio=' + r.candidate.priority);
  assert(ranked.target !== null, 'hitTestPane finds a winner under the pointer');
  // arbitration: the ranked list is best-first (non-decreasing distance within tier).
  for (let i = 1; i < ranked.ranked.length; i++) {
    const a = ranked.ranked[i - 1].candidate;
    const b = ranked.ranked[i].candidate;
    assert(tier(a.priority) > tier(b.priority) || a.distance <= b.distance + 1e-9, 'ranked is best-first');
  }

  // --- axis layout: optimal price/time widths + heights (§5.4 / §13.6) --------
  const font = { family: 'sans-serif', size: 12 };
  const priceLayout = layoutPriceAxis(
    {
      ticks: [{ text: '10.00' }, { text: '12.00' }, { text: '14.00' }],
      backLabels: [],
      crosshair: null,
      font,
    },
    measurer,
  );
  const timeLayout = layoutTimeAxis(
    {
      marks: [
        { coordinate: 64, label: "09:30", weight: 30, needAlign: true },
        { coordinate: 74, label: "10:00", weight: 30, needAlign: false },
        { coordinate: 84, label: "11:00", weight: 30, needAlign: false },
        { coordinate: 94, label: "12:00", weight: 30, needAlign: true },
      ],
      font,
      width: 100,
    },
    measurer,
  );
  lines.push('');
  lines.push('=== axis layout (measurer: width=6·len, ascent 8 / descent 2; font 12px) ===');
  lines.push('  price axis: maxLabelWidth=' + priceLayout.maxLabelWidth + ' width=' + priceLayout.width + ' labels=' + priceLayout.labels.length);
  lines.push('  time  axis: height=' + timeLayout.height + ' labels=' + timeLayout.labels.length + ' boldCount=' + timeLayout.labels.filter((l) => l.bold).length);
  // hand-derived (study 04 §3.7): ticks '10.00'/'14.00' both 6·5=30 px; pad = 12/12·5
  // = 5; width = evenCeil(1 + 5 + 2·5 + 5 + 30) = evenCeil(51) = 52.
  assert(priceLayout.maxLabelWidth === 30, 'price maxLabelWidth = 6·5');
  assert(priceLayout.width === 52, 'price width = evenCeil(1+5+10+5+30) = 52');
  // time height = evenCeil(1 + 5 + 12 + 3·12/12 + 3·12/12 + 4·12/12)
  //             = evenCeil(1 + 5 + 12 + 3 + 3 + 4) = evenCeil(28) = 28.
  assert(timeLayout.height === 28, 'time height = evenCeil(28) = 28');
  assert(timeLayout.labels.length === 4, 'four time labels');

  lines.push('');
  lines.push('demo-views OK: 6 kinds + grid + crosshair composited both layers; ' + totalCmds + ' commands, hit winner ' + ranked.target.sourceId + '.');
  return lines;
}

// --- print helpers ------------------------------------------------------------

function printLayer(lines, lists) {
  lines.push('  lists=' + lists.length);
  for (let i = 0; i < lists.length; i++) {
    const l = lists[i];
    const kinds = l.commands.map((c) => c.kind + '×' + commandSize(c)).join(', ');
    lines.push('  [' + i + '] ' + l.space + ': ' + (kinds === '' ? '(empty)' : kinds));
  }
}

const tier = (p) => (p === 2 ? 1 : 0); // HitPriority.Point === 2 → top tier
const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
const fmt = (n) => (Number.isFinite(n) ? (Math.round(n * 1e4) / 1e4).toString() : String(n));
`;

const dir = mkdtempSync(join(tmpdir(), 'tvdemo-'));
const out = join(dir, 'demo.mjs');
await build({
  stdin: { contents: demoSource, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'demo-views.ts' },
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

const goldenPath = 'scripts/demo-views.golden.txt';
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, output + '\n');
  console.log('\ndemo-views: recorded baseline -> ' + goldenPath);
} else if (norm(output) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-views: STDOUT does not match ' + goldenPath);
  process.exit(1);
} else {
  console.log('\ndemo-views: output matches golden.');
}
