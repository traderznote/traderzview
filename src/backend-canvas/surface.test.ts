import { describe, expect, test, vi } from 'vitest';
import type { DisplayList, RectsCommand } from '../gfx';
import { CanvasBinding, type BitmapObserver } from './binding';
import { CanvasSurface } from './surface';
import { MockCanvas } from './mock-context.test';

class FakeObserver implements BitmapObserver {
  readonly reprediction = false;
  #cb: ((w: number, h: number) => void) | undefined;
  start(cb: (w: number, h: number) => void): void {
    this.#cb = cb;
  }
  emit(w: number, h: number): void {
    this.#cb?.(w, h);
  }
  dispose(): void {}
}

function makeSurface(): {
  surface: CanvasSurface;
  base: MockCanvas;
  overlay: MockCanvas;
  baseObs: FakeObserver;
  overlayObs: FakeObserver;
} {
  const base = new MockCanvas();
  const overlay = new MockCanvas();
  const baseObs = new FakeObserver();
  const overlayObs = new FakeObserver();
  const baseBinding = new CanvasBinding(base as unknown as HTMLCanvasElement, baseObs);
  const overlayBinding = new CanvasBinding(overlay as unknown as HTMLCanvasElement, overlayObs);
  const surface = new CanvasSurface({
    baseCanvas: base as unknown as HTMLCanvasElement,
    overlayCanvas: overlay as unknown as HTMLCanvasElement,
    baseBinding,
    overlayBinding,
    createCanvas: () => new MockCanvas() as unknown as HTMLCanvasElement,
    colorSpace: 'srgb',
  });
  return { surface, base, overlay, baseObs, overlayObs };
}

function fullQuad(w: number, h: number): RectsCommand {
  return { kind: 'rects', coords: new Float32Array([0, 0, w, h]), runs: [{ count: 1, fill: '#111' }] };
}

describe('CanvasSurface FrameInfo', () => {
  test('derives hr/vr per axis from actual sizes', () => {
    const { surface, baseObs, overlayObs } = makeSurface();
    surface.setMediaSize({ width: 300, height: 150 });
    baseObs.emit(600, 450); // hr=2, vr=3
    overlayObs.emit(600, 450);
    const fi = surface.beginFrame('full');
    expect(fi.mediaSize).toEqual({ width: 300, height: 150 });
    expect(fi.bitmapSize).toEqual({ width: 600, height: 450 });
    expect(fi.hr).toBe(2);
    expect(fi.vr).toBe(3);
  });

  test('degenerate 0-dim surface yields finite FrameInfo (ratio 1, never NaN) per zeroed axis', () => {
    const { surface } = makeSurface();
    surface.setMediaSize({ width: 0, height: 0 });
    const fi = surface.beginFrame('full');
    expect(fi.mediaSize).toEqual({ width: 0, height: 0 });
    expect(fi.bitmapSize).toEqual({ width: 0, height: 0 });
    expect(fi.hr).toBe(1);
    expect(fi.vr).toBe(1);
    expect(Number.isNaN(fi.hr)).toBe(false);
    expect(Number.isNaN(fi.vr)).toBe(false);
  });

  test('a surface zero on ONE axis keeps the live ratio on the other', () => {
    const { surface, baseObs, overlayObs } = makeSurface();
    surface.setMediaSize({ width: 300, height: 0 });
    baseObs.emit(600, 0); // clamp keeps height 0
    overlayObs.emit(600, 0);
    const fi = surface.beginFrame('full');
    expect(fi.hr).toBe(2);
    expect(fi.vr).toBe(1); // zero-height axis pinned to 1
  });
});

describe('CanvasSurface scope-gated bitmap resize (design 03 §5.1.4)', () => {
  test("beginFrame('full') applies the pending bitmap resize on both canvases", () => {
    const { surface, base, overlay, baseObs, overlayObs } = makeSurface();
    surface.setMediaSize({ width: 300, height: 150 });
    baseObs.emit(600, 300);
    overlayObs.emit(600, 300);
    surface.beginFrame('full');
    expect(base.width).toBe(600);
    expect(overlay.width).toBe(600);
  });

  test("beginFrame('overlay') NEVER applies a pending bitmap resize", () => {
    const { surface, base, overlay, baseObs, overlayObs } = makeSurface();
    surface.setMediaSize({ width: 300, height: 150 });
    baseObs.emit(600, 300);
    overlayObs.emit(600, 300);
    surface.beginFrame('overlay');
    expect(base.width).toBe(0); // pending suggestion stays pending
    expect(overlay.width).toBe(0);
    expect(surface.beginFrame).toBeTypeOf('function');
  });
});

describe('CanvasSurface renderLayer', () => {
  test("renderLayer('base', …) inside an 'overlay' scope is a dev-assert/no-op (base bitmap untouched)", () => {
    const { surface, base, baseObs, overlayObs } = makeSurface();
    surface.setMediaSize({ width: 300, height: 150 });
    baseObs.emit(600, 300);
    overlayObs.emit(600, 300);
    surface.beginFrame('full');
    surface.endFrame();
    base.ctx.log.length = 0; // reset
    surface.beginFrame('overlay');
    expect(() => surface.renderLayer('base', [{ space: 'bitmap', commands: [fullQuad(600, 300)] }])).toThrow(
      /base.*overlay|overlay.*base|scope/i,
    );
    // and the base ctx received nothing
    expect(base.ctx.log.length).toBe(0);
    surface.endFrame();
  });

  test("renderLayer('overlay') in an overlay frame draws to the overlay canvas only", () => {
    const { surface, base, overlay, baseObs, overlayObs } = makeSurface();
    surface.setMediaSize({ width: 300, height: 150 });
    baseObs.emit(600, 300);
    overlayObs.emit(600, 300);
    surface.beginFrame('full');
    surface.endFrame();
    base.ctx.log.length = 0;
    overlay.ctx.log.length = 0;
    surface.beginFrame('overlay');
    surface.renderLayer('overlay', [{ space: 'bitmap', commands: [fullQuad(600, 300), fullQuad(600, 300)] }]);
    surface.endFrame();
    expect(overlay.ctx.ops('clearRect').length).toBeGreaterThan(0);
    expect(base.ctx.log.length).toBe(0);
  });

  test('replace-semantics: a second renderLayer of a layer discards the first (clear + replay only the new lists)', () => {
    const { surface, base, baseObs, overlayObs } = makeSurface();
    surface.setMediaSize({ width: 300, height: 150 });
    baseObs.emit(600, 300);
    overlayObs.emit(600, 300);
    surface.beginFrame('full');
    // first render: two lists (so we don't take the copy fast path), green fills
    surface.renderLayer('base', [
      { space: 'bitmap', commands: [{ kind: 'rects', coords: new Float32Array([0, 0, 5, 5]), runs: [{ count: 1, fill: '#0f0' }] }] },
      { space: 'bitmap', commands: [fullQuad(600, 300)] },
    ]);
    base.ctx.log.length = 0; // forget the first render
    // second render of the SAME layer: a single red list
    surface.renderLayer('base', [
      { space: 'bitmap', commands: [{ kind: 'rects', coords: new Float32Array([0, 0, 5, 5]), runs: [{ count: 1, fill: '#f00' }] }] },
      { space: 'bitmap', commands: [fullQuad(600, 300)] },
    ]);
    surface.endFrame();
    // the second render started with a clear, then only red fills — no green survives
    expect(base.ctx.ops('clearRect').length).toBeGreaterThan(0);
    const fills = base.ctx.ops('fill').map((e) => e.args[0]);
    expect(fills).toContain('#f00');
    expect(fills).not.toContain('#0f0');
  });

  test('degenerate surface: renderLayer/endFrame/snapshot silently no-op', () => {
    const { surface, base } = makeSurface();
    surface.setMediaSize({ width: 0, height: 100 });
    surface.beginFrame('full');
    surface.renderLayer('base', [{ space: 'bitmap', commands: [fullQuad(0, 200)] }]);
    surface.endFrame();
    const snap = surface.snapshot();
    expect(base.ctx.log.length).toBe(0); // nothing drawn
    expect(snap).toBeDefined();
  });
});

describe('CanvasSurface resolutionChanged + dispose', () => {
  test('aggregates both bindings resolutionChanged', () => {
    const { surface, baseObs, overlayObs } = makeSurface();
    surface.setMediaSize({ width: 300, height: 150 });
    const cb = vi.fn();
    surface.resolutionChanged.subscribe(cb);
    baseObs.emit(600, 300);
    overlayObs.emit(600, 300);
    expect(cb.mock.calls.length).toBe(2);
  });

  test('dispose tears down both bindings (canvases shrink to 1×1)', () => {
    const { surface, base, overlay } = makeSurface();
    surface.setMediaSize({ width: 300, height: 150 });
    surface.dispose();
    expect(base.width).toBe(1);
    expect(overlay.width).toBe(1);
  });
});
