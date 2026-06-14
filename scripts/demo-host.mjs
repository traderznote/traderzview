// M8 demo (roadmap §M8) — the HEADLESS proof the host module is correct with NO
// browser and NO concrete backend. It wires the REAL host pieces — FrameLoop +
// SurfaceHost + GestureMachine + InteractionRouter + default behaviors + normalizeWheel
// — to an INJECTED stub backend (an ISurface that records beginFrame/renderLayer/
// endFrame) + a fake rAF + a fake mount, then drives a synthetic pointer drag and a
// wheel event and verifies (record-then-gate vs scripts/demo-host.golden.txt):
//   1. the per-UpdateLevel backend call sequence (design 03 §6);
//   2. one-frame coalescing per turn (many invalidations → one rAF tick, perf §4.4);
//   3. a synchronous-resize inline repaint (study 05 §3.8 — no rAF, paints inline).
// Bundled from TS via esbuild (stdin loader 'ts') like the sibling demos. Structural
// invariants are asserted INSIDE render() so a regression fails even if re-recorded.
// FOLLOW-UP: the browser Playwright demo scripts/demo-host.html is CI-gated (mirrors
// M6/M7) and out of scope here.
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demoSource = `
import {
  FrameLoop,
  SurfaceHost,
  GestureMachine,
  InteractionRouter,
  registerDefaultBehaviors,
  normalizeWheel,
} from './src/host/index';
import { UpdateLevel, createMask } from './src/model/index';

const assert = (cond, msg) => { if (!cond) throw new Error('demo-host assert: ' + msg); };

// --- fake rAF: a single-slot scheduler test-driver. schedule() stores the callback;
//     flush(now) fires the one pending callback (matches createRafScheduler fan-out
//     for our single FrameLoop consumer). Records nothing — the backend log is the proof.
function makeRaf() {
  let pending = null;
  let nextNow = 0;
  return {
    scheduler: {
      schedule(cb) { pending = cb; return () => { if (pending === cb) pending = null; }; },
      dispose() { pending = null; },
    },
    hasPending() { return pending !== null; },
    flush(now) {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(now ?? nextNow++);
    },
  };
}

// --- stub backend surface: records the §6 call sequence into a shared log. NO pixels,
//     NO DOM — proves the host issues the right begin/render/end calls per UpdateLevel.
function makeSurface(log, name) {
  let media = { width: 0, height: 0 };
  return {
    setMediaSize(s) { media = s; log.push(name + '.setMediaSize ' + s.width + 'x' + s.height); },
    beginFrame(scope) {
      log.push(name + '.beginFrame ' + scope);
      const hr = media.width === 0 ? 1 : 2, vr = media.height === 0 ? 1 : 2;
      return { mediaSize: media, bitmapSize: { width: media.width * 2, height: media.height * 2 }, hr, vr };
    },
    renderLayer(layer, lists) { log.push(name + '.renderLayer ' + layer + ' (lists=' + lists.length + ')'); },
    endFrame() { log.push(name + '.endFrame'); },
    resolutionChanged: { subscribe() { return () => {}; } },
    snapshot() { return { _tag: 'SurfaceSnapshot' }; },
    dispose() {},
  };
}

// --- a PaneScene-shaped stub: composite(layer, frame) returns one empty list per layer
//     so SurfaceHost.paint exercises the real §6 dispatch without needing views/gfx.
function makeScene() {
  return { composite() { return [{ space: 'media', commands: [] }]; } };
}

// --- a fake mount element: records nothing but satisfies HostElement (style + getRect).
function makeMount() {
  return {
    style: { position: '', left: '', top: '', width: '', height: '' },
    appendChild() {}, removeChild() {},
    getBoundingClientRect() { return { left: 0, top: 0, width: 600, height: 400 }; },
  };
}

export function render() {
  const lines = [];
  const log = [];

  // === build a single pane SurfaceHost over the stub backend (the §6 unit) ===========
  const surface = makeSurface(log, 'pane');
  const factory = { createSurface() { return surface; } };
  const sh = new SurfaceHost(makeMount(), factory, { kind: 'pane', scene: makeScene() }, () => {});
  sh.setRect({ x: 0, y: 0, width: 600, height: 400 }); // visible; sets media size
  log.length = 0; // clear the setMediaSize from layout; the gate watches paint sequences

  // === the FrameDriver the loop drives — paint() routes to SurfaceHost.paint(level) ===
  // syncWidgets/computeLayout/applySizes are layout steps; here they only LOG so the
  // golden shows the Layout-frame step ordering (§4.4: sync → layout → sizes → render).
  let rearm = UpdateLevel.None;
  const driver = {
    syncWidgets() { log.push('driver.syncWidgets'); },
    computeLayout() { log.push('driver.computeLayout'); },
    applySizes() { log.push('driver.applySizes'); },
    applyRender(_mask, _now) { log.push('driver.applyRender'); },
    paint(level, now) { sh.paint(level, now); },
    animationRearmLevel() { return rearm; },
  };

  const raf = makeRaf();
  const loop = new FrameLoop(raf.scheduler, driver);

  // === 1. OVERLAY frame: one invalidate → one rAF tick → overlay-only §6 sequence =====
  lines.push('=== Overlay frame (design 03 §6: overlay layer only) ===');
  loop.invalidate(createMask({ level: UpdateLevel.Overlay }));
  assert(raf.hasPending(), 'an Overlay invalidate arms exactly one rAF');
  raf.flush(1000);
  printLog(lines, log);
  // §6 row Overlay: beginFrame('overlay') → renderLayer('overlay') → endFrame. NO base.
  assertSeq(log, ['pane.beginFrame overlay', 'pane.renderLayer overlay (lists=1)', 'pane.endFrame']);
  assert(!log.some((l) => l.includes('renderLayer base')), 'Overlay never touches the base layer (§6/§5.1.3)');
  log.length = 0;

  // === 2. coalescing: MANY invalidations in one turn collapse to ONE Render frame =====
  lines.push('');
  lines.push('=== One-frame coalescing (perf §4.4: N invalidations → 1 tick) ===');
  loop.invalidate(createMask({ level: UpdateLevel.Overlay }));
  loop.invalidate(createMask({ level: UpdateLevel.Render }));  // promotes the pending mask
  loop.invalidate(createMask({ level: UpdateLevel.Overlay }));
  assert(raf.hasPending(), 'three invalidations still arm only one rAF');
  let frames = 0;
  const countOnce = log.length;
  raf.flush(1016);
  void countOnce;
  // exactly one paint pass happened (one beginFrame), and the surviving level is Render.
  frames = log.filter((l) => l === 'pane.beginFrame full').length;
  printLog(lines, log);
  assert(frames === 1, 'coalesced to exactly one Render frame (one beginFrame full)');
  assert(!raf.hasPending(), 'no second frame is armed after the coalesced tick');
  // §6 row Render: beginFrame('full') → renderLayer('base') → renderLayer('overlay') → end.
  assertSeq(log.filter((l) => l.startsWith('pane.')),
    ['pane.beginFrame full', 'pane.renderLayer base (lists=1)', 'pane.renderLayer overlay (lists=1)', 'pane.endFrame']);
  log.length = 0;

  // === 3. synchronous resize: flushSync paints INLINE, NO rAF (study 05 §3.8) =========
  lines.push('');
  lines.push('=== Synchronous resize repaint (study 05 §3.8: inline, no rAF) ===');
  assert(!raf.hasPending(), 'no frame pending before the sync flush');
  loop.flushSync(createMask({ level: UpdateLevel.Layout }), 2000);
  assert(!raf.hasPending(), 'flushSync paints inline — it arms NO rAF');
  printLog(lines, log);
  // Layout frame (§6 row Layout = the layout steps, then "as Render"): sync → layout →
  // sizes → render, then the full §6 paint sequence.
  assertSeq(log, [
    'driver.syncWidgets', 'driver.computeLayout', 'driver.applySizes', 'driver.applyRender',
    'pane.beginFrame full', 'pane.renderLayer base (lists=1)', 'pane.renderLayer overlay (lists=1)', 'pane.endFrame',
  ]);
  log.length = 0;

  // === 4. flushSync CANCELS a pending rAF so the work is not double-painted ===========
  lines.push('');
  lines.push('=== flushSync cancels a pending rAF (no double paint) ===');
  loop.invalidate(createMask({ level: UpdateLevel.Render }));
  assert(raf.hasPending(), 'a Render invalidate armed a rAF');
  loop.flushSync(createMask({ level: UpdateLevel.Layout }), 2100); // forced resize mid-pending
  assert(!raf.hasPending(), 'flushSync cancelled the pending rAF');
  const painted = log.filter((l) => l === 'pane.beginFrame full').length;
  printLog(lines, log);
  assert(painted === 1, 'the cancelled rAF + the sync flush together paint exactly once');
  raf.flush(2116); // the cancelled callback must NOT fire any extra frame
  assert(log.filter((l) => l === 'pane.beginFrame full').length === 1, 'no extra frame from the cancelled rAF');
  log.length = 0;

  // === 5. gesture drag → InteractionRouter → default PAN behavior intents =============
  lines.push('');
  lines.push('=== Drag gesture → router → default pan/clearHover intents ===');
  const router = new InteractionRouter();
  const intents = [];
  registerDefaultBehaviors(router, {
    pan: (dx) => intents.push('pan ' + dx),
    zoom: (step, atX) => intents.push('zoom ' + step + ' @' + atX),
    resetPane: (i) => intents.push('resetPane ' + i),
    priceAxisDrag: (i, dy, axis) => intents.push('axisDrag ' + i + ' ' + dy + ' ' + axis),
    clearHover: () => intents.push('clearHover'),
  });
  let t = 0;
  const machine = new GestureMachine({ surface: 'pane', paneIndex: 0 }, () => t, (e) => router.dispatch(e));
  const ptr = (x, y, buttons) => ({ pointerId: 1, clientX: x, clientY: y, buttons, pointerType: 'mouse', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false });
  // press, move past the 5-px drag slop (study 07 §4.1) → drag start; two more moves; up.
  machine.pointerDown(ptr(100, 100, 1));
  machine.pointerMove(ptr(110, 100, 1)); // |Δ|=10 ≥ 5 slop → drag 'start' (clearHover, no pan yet)
  machine.pointerMove(ptr(130, 100, 1)); // 'move' Δx=+20 → pan(20)
  machine.pointerMove(ptr(125, 100, 1)); // 'move' Δx=−5  → pan(−5)
  machine.pointerUp(ptr(125, 100, 1));   // 'end' (no pan)
  for (const i of intents) lines.push('  ' + i);
  // start fires clearHover (a pan hides the crosshair); each subsequent move pans by Δx.
  assertSeq(intents, ['clearHover', 'pan 20', 'pan -5']);

  // === 6. wheel normalization → router → default ZOOM intent (study 10 §4.4) ==========
  lines.push('');
  lines.push('=== Wheel (PIXEL deltaY=−100) → normalize → router zoom intent ===');
  // deltaY −100 PIXEL, speed 1, non-Windows: dy = −(1·−100)/100 = +1 → zoom = sign(1)·min(1,1)=+1.
  const nw = normalizeWheel({ deltaMode: 0, deltaX: 0, deltaY: -100, ctrlKey: false }, 1, false, 1);
  lines.push('  normalizeWheel(deltaY=-100) → scroll=' + nw.scroll + ' zoom=' + nw.zoom);
  assert(nw.zoom === 1 && nw.scroll === 0, 'deltaY=-100 PIXEL normalizes to zoom=+1, scroll=0 (study 10 §4.4)');
  intents.length = 0;
  // The host builds a 'wheel' GestureEvent carrying the normalized deltas; feed it directly.
  router.dispatch(wheelEvent(0, nw.zoom, 250));
  for (const i of intents) lines.push('  ' + i);
  assertSeq(intents, ['zoom 1 @250']);

  lines.push('');
  lines.push('demo-host OK: §6 call sequence per level, one-frame coalescing, inline sync resize, drag→pan + wheel→zoom intents.');
  return lines;
}

// A minimal recognized 'wheel' GestureEvent (the host builds this from normalizeWheel).
function wheelEvent(wdx, wdy, x) {
  return {
    kind: 'wheel', phase: 'fire', surface: 'pane', paneIndex: 0,
    x, y: 100, startX: x, startY: 100, deltaX: 0, deltaY: 0,
    wheelDeltaX: wdx, wheelDeltaY: wdy, pointerType: 'mouse',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
  };
}

function printLog(lines, log) {
  for (const l of log) lines.push('  ' + l);
}

// Assert an exact ordered sequence (the §6 / coalescing structural invariant).
function assertSeq(actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error('demo-host assertSeq: expected ' + e + ' got ' + a);
}
`;

const dir = mkdtempSync(join(tmpdir(), 'tvdemo-'));
const out = join(dir, 'demo.mjs');
await build({
  stdin: { contents: demoSource, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'demo-host.ts' },
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

const goldenPath = 'scripts/demo-host.golden.txt';
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, output + '\n');
  console.log('\ndemo-host: recorded baseline -> ' + goldenPath);
} else if (norm(output) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-host: STDOUT does not match ' + goldenPath);
  process.exit(1);
} else {
  console.log('\ndemo-host: output matches golden.');
}
