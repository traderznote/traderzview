// M5 demo (roadmap §M5(e)) — the HEADLESS proof the model is correct before any
// pixels exist. Constructs a ChartModel with the time behavior, applies a seeded
// dataset through the M4 Timeline, drives a scripted sequence
// (fitContent → setBarSpacing → kinetic fling → manual price drag → percent-mode
// switch) and prints, after each step: the HorzScaleCommand queue (proving the
// reduceHorzCommands laws), the resulting HorzGeometry / PriceConverter snapshots,
// and the UpdateMask levels emitted. Bundled-from-TS via esbuild (stdin loader
// 'ts', resolveDir cwd, define __DEV__/__TV_PROFILE__) and gated against
// scripts/demo-model.golden.txt (record-then-gate, like the sibling demos).
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demoSource = `
import { Timeline, timeBehavior } from './src/data/index';
import {
  ChartModel,
  reduceHorzCommands,
  buildHorzGeometry,
  buildPriceConverter,
  createKineticAnimation,
  kineticTuningForBarSpacing,
  assembleRange,
  PriceNavigator,
  PriceScaleMode,
} from './src/model/index';

const LEVEL_NAME = { 0: 'None', 1: 'Overlay', 2: 'Render', 3: 'Layout' };

function fmtQueue(queue) {
  if (queue.length === 0) return '[]';
  return '[' + queue.map((c) => c.kind).join(', ') + ']';
}

function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  return (Math.round(n * 1e4) / 1e4).toString();
}

export function render() {
  const lines = [];

  // --- construct the model with the injected invalidation callback ------------
  const masks = [];
  const behavior = timeBehavior();
  const model = new ChartModel({ behavior, invalidate: (m) => masks.push(m) });
  lines.push('model: panes=' + model.panes().count() + ', defaultPriceScaleId=' + model.options().defaultPriceScaleId);

  // --- apply a seeded dataset through the M4 Timeline -------------------------
  const tl = new Timeline(behavior);
  const data = [
    { time: 1, value: 10 },
    { time: 2, value: 14 },
    { time: 3, value: 9 },
    { time: 4, value: 17 },
    { time: 5, value: 13 },
  ];
  const applied = tl.applySeriesData('s', data, behavior);
  lines.push('data: slotCount=' + tl.slotCount + ' baseIndex=' + applied.baseIndex + ' rows=' + applied.rows.length);

  // geometry parameters driven by the scripted sequence (the model state the host
  // would hold; the demo drives the navigator math directly to print snapshots).
  const W = 600;
  const baseIndex = applied.baseIndex;
  const barCount = tl.slotCount;
  let barSpacing = 6;
  let rightOffset = 0;

  // the HorzScaleCommand queue, accumulated through the reducer (the laws under test).
  let queue = [];

  function step(label, command) {
    masks.length = 0;
    model.queueHorzCommand(command);
    queue = reduceHorzCommands(queue, command);
    const mask = masks[0];
    const g = buildHorzGeometry({ width: W, barSpacing, rightOffset, baseIndex });
    lines.push('');
    lines.push('STEP ' + label);
    lines.push('  command: ' + command.kind);
    lines.push('  queue after reduce: ' + fmtQueue(queue));
    lines.push('  mask: level=' + LEVEL_NAME[mask.level] + ' autoscalePanes=' + mask.autoscalePanes.size + ' horzCommands=' + mask.horzCommands.length);
    lines.push('  HorzGeometry: barSpacing=' + fmt(g.barSpacing) + ' rightOffset=' + fmt(g.rightOffset) + ' x(base)=' + fmt(g.indexToCoordinate(baseIndex)) + ' logical(0)=' + fmt(g.coordinateToLogical(0)));
  }

  // STEP 1 — fitContent: REPLACES the queue (implies both spacing + offset).
  barSpacing = (W) / barCount;
  rightOffset = 0;
  step('1 fitContent', { kind: 'fitContent' });

  // STEP 2 — setBarSpacing: APPENDS after cancelling any pending animate.
  barSpacing = 12;
  step('2 setBarSpacing(12)', { kind: 'setBarSpacing', value: barSpacing });

  // STEP 3 — kinetic fling: createKineticAnimation closed form, then 'animate'.
  const flingVelocity = 0.5; // bars/ms (already barSpacing-normalized by the host)
  const tuning = kineticTuningForBarSpacing(barSpacing);
  const anim = createKineticAnimation(rightOffset, flingVelocity, 1000, tuning);
  lines.push('');
  lines.push('kinetic: tuning.epsilon=' + fmt(tuning.epsilon) + ' (= 1px / barSpacing)');
  lines.push('  positionAt(1000)=' + fmt(anim.positionAt(1000)) + ' positionAt(1050)=' + fmt(anim.positionAt(1050)) + ' finished(1000)=' + anim.finished(1000));
  // advance the offset to the animation's resting position to feed the geometry snapshot.
  rightOffset = anim.positionAt(1e9);
  step('3 kinetic fling (animate)', { kind: 'animate', animation: anim });

  // STEP 3b — stopAnimation: REMOVES the pending animate AND survives in the queue.
  step('3b stopAnimation', { kind: 'stopAnimation' });

  // --- manual price drag (price-scale navigator) ------------------------------
  // assemble an autoscale range from the data, seed the right scale, then drag.
  const rng = data.reduce((a, d) => ({ min: Math.min(a.min, d.value), max: Math.max(a.max, d.value) }), { min: Infinity, max: -Infinity });
  const assembled = assembleRange({
    contributors: [{ firstValue: data[0].value, range: rng, margins: { above: 0, below: 0 } }],
    mode: PriceScaleMode.Normal,
    minMove: 0.01,
    logFormula: { logicalOffset: 4, coordOffset: 1e-4 },
  });
  const rightScale = model.panes().panes()[0].priceScale('right');
  rightScale.setRange(assembled.range);
  const H = 400; // internal band height for the drag math (margins removed upstream).
  const before = rightScale.range();
  // a dedicated navigator with a real height so the drag arithmetic is legible
  // (the PriceScale's own navigator carries the model state; this proves the math).
  const nav = new PriceNavigator({
    range: before,
    autoScale: true,
    mode: PriceScaleMode.Normal,
    inverted: false,
    height: H,
  });
  nav.startScroll(200); // no-op while autoScale is ON (study 04 §3.4)
  const blockedWhileAuto = nav.range() === before;
  nav.setAutoScale(false);
  nav.startScroll(200);
  nav.scrollTo(230); // drag 30 px down
  const afterDrag = nav.range();
  rightScale.applyOptions({ autoScale: false });
  rightScale.setRange(afterDrag);
  lines.push('');
  lines.push('STEP 4 manual price drag (scroll 30px, autoScale off)');
  lines.push('  scroll blocked while autoScale ON: ' + blockedWhileAuto);
  lines.push('  range before: min=' + fmt(before.min) + ' max=' + fmt(before.max));
  lines.push('  range after:  min=' + fmt(afterDrag.min) + ' max=' + fmt(afterDrag.max));
  // a manual price drag raises a Render mask + a one-shot autoscale-off recalc.
  masks.length = 0;
  const paneId = model.panes().panes()[0].id();
  model.invalidateAutoscale(paneId);
  lines.push('  mask: level=' + LEVEL_NAME[masks[0].level] + ' autoscalePanes=' + masks[0].autoscalePanes.size);

  // --- percent-mode switch ----------------------------------------------------
  rightScale.applyOptions({ mode: PriceScaleMode.Percentage });
  const pc = buildPriceConverter({
    height: H,
    range: rightScale.range(),
    scaleMargins: { top: 0.2, bottom: 0.1 },
    marginAbovePx: 0,
    marginBelowPx: 0,
    mode: rightScale.mode(),
    inverted: false,
    firstValue: data[0].value,
  });
  lines.push('');
  lines.push('STEP 5 percent-mode switch');
  lines.push('  scale.mode=' + rightScale.mode() + ' (Percentage forces autoScale=' + rightScale.isAutoScale() + ')');
  lines.push('  PriceConverter: mode=' + pc.mode + ' firstValue=' + pc.firstValue + ' toLogical(20)=' + fmt(pc.toLogical(20)) + ' y(20)=' + fmt(pc.priceToCoordinate(20)));

  lines.push('');
  lines.push('mask invariant proof (None never carries work):');
  lines.push('  applyOptions(no-op) emits ' + (() => { masks.length = 0; model.applyOptions({ crosshair: { mode: 'magnet' } }); return masks.length; })() + ' masks');
  lines.push('  applyOptions(crosshair.mode=normal) → level=' + (() => { masks.length = 0; model.applyOptions({ crosshair: { mode: 'normal' } }); return LEVEL_NAME[masks[0].level]; })());
  lines.push('  applyOptions(width=800) → level=' + (() => { masks.length = 0; model.applyOptions({ width: 800 }); return LEVEL_NAME[masks[0].level]; })());

  return lines;
}
`;

const dir = mkdtempSync(join(tmpdir(), 'tvdemo-'));
const out = join(dir, 'demo.mjs');
await build({
  stdin: { contents: demoSource, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'demo-model.ts' },
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

const goldenPath = 'scripts/demo-model.golden.txt';
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, output + '\n');
  console.log('\ndemo-model: recorded baseline -> ' + goldenPath);
} else if (norm(output) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-model: STDOUT does not match ' + goldenPath);
  process.exit(1);
} else {
  console.log('\ndemo-model: output matches golden.');
}
