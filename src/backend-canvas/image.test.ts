// Runs headless in node (no jsdom): the mock canvas stands in for the offscreen
// canvas, so composeSnapshot's blit math is asserted against the recording log.
import { describe, expect, test, vi } from 'vitest';
import type { SnapshotTile, SurfaceSnapshot } from '../gfx';
import {
  composeSnapshot,
  createCanvasImage,
  makeSurfaceSnapshot,
  naturalSize,
  type CanvasSnapshot,
  type CanvasSurfaceSnapshot,
} from './image';
import { MockCanvas } from './mock-context.test';

describe('naturalSize', () => {
  test('reads naturalWidth/Height (HTMLImageElement)', () => {
    expect(naturalSize({ naturalWidth: 30, naturalHeight: 20 } as unknown as CanvasImageSource)).toEqual({
      width: 30,
      height: 20,
    });
  });
  test('reads videoWidth/Height (HTMLVideoElement)', () => {
    expect(naturalSize({ videoWidth: 64, videoHeight: 48 } as unknown as CanvasImageSource)).toEqual({
      width: 64,
      height: 48,
    });
  });
  test('reads width/height (canvas / ImageBitmap)', () => {
    expect(naturalSize({ width: 12, height: 8 } as unknown as CanvasImageSource)).toEqual({ width: 12, height: 8 });
  });
});

describe('createCanvasImage', () => {
  test('wraps the source, captures its natural size, exposes source; dispose drops it', () => {
    const src = { naturalWidth: 50, naturalHeight: 25 } as unknown as CanvasImageSource;
    const handle = createCanvasImage(src);
    expect(handle.size).toEqual({ width: 50, height: 25 });
    expect(handle.source).toBe(src);
    handle.dispose(); // must not throw
  });
});

describe('makeSurfaceSnapshot (two detached layer copies, §8.6)', () => {
  test('copies base + overlay into fresh offscreen canvases sized to the bitmap', () => {
    const created: MockCanvas[] = [];
    const create = (): MockCanvas => {
      const c = new MockCanvas();
      created.push(c);
      return c;
    };
    const liveBase = new MockCanvas();
    const liveOverlay = new MockCanvas();
    const snap = makeSurfaceSnapshot(
      liveBase as unknown as HTMLCanvasElement,
      liveOverlay as unknown as HTMLCanvasElement,
      { width: 200, height: 80 },
      create as unknown as () => HTMLCanvasElement,
    ) as CanvasSurfaceSnapshot & { base: MockCanvas; overlay: MockCanvas };
    // two NEW canvases (detached from the live layers), each sized to the bitmap.
    expect(created).toHaveLength(2);
    expect(snap.base).toBe(created[0]);
    expect(snap.overlay).toBe(created[1]);
    expect(created[0].width).toBe(200);
    expect(created[0].height).toBe(80);
    expect(snap.size).toEqual({ width: 200, height: 80 });
    // each copy blits its live source once (so a later frame can't corrupt the snapshot).
    expect(created[0].ctx.ops('drawImage')[0].args[0]).toBe(liveBase);
    expect(created[1].ctx.ops('drawImage')[0].args[0]).toBe(liveOverlay);
  });

  test('degenerate (0-dim) surface: copies are zero-size and no blits run (study 05 §5 guard)', () => {
    const created: MockCanvas[] = [];
    const create = (): MockCanvas => {
      const c = new MockCanvas();
      created.push(c);
      return c;
    };
    const snap = makeSurfaceSnapshot(
      new MockCanvas() as unknown as HTMLCanvasElement,
      new MockCanvas() as unknown as HTMLCanvasElement,
      { width: 0, height: 80 },
      create as unknown as () => HTMLCanvasElement,
    );
    expect(snap.size).toEqual({ width: 0, height: 80 });
    expect(created[0].ctx.ops('drawImage')).toHaveLength(0);
    expect(created[1].ctx.ops('drawImage')).toHaveLength(0);
  });
});

describe('composeSnapshot (single pass, mediaSize × dpr)', () => {
  function fakeFactory(): { create: () => MockCanvas; created: MockCanvas[] } {
    const created: MockCanvas[] = [];
    return {
      created,
      create: () => {
        const c = new MockCanvas();
        created.push(c);
        return c;
      },
    };
  }

  // A two-layer snapshot tile (the CanvasSurfaceSnapshot shape): base + overlay canvases.
  function tileSnapshot(w: number, h: number): SurfaceSnapshot & { base: MockCanvas; overlay: MockCanvas } {
    return { base: new MockCanvas(), overlay: new MockCanvas(), size: { width: w, height: h } } as never;
  }

  test('output canvas sized mediaSize × dpr; snapshot tiles blit BOTH layers into rect×dpr; fill tiles filled', () => {
    const f = fakeFactory();
    const snap = tileSnapshot(200, 80);
    const tiles: SnapshotTile[] = [
      { rect: { x: 10, y: 5, width: 100, height: 40 }, snapshot: snap },
      { rect: { x: 0, y: 0, width: 8, height: 200 }, fill: '#222' },
    ];
    const out = composeSnapshot(
      tiles,
      { width: 300, height: 200 },
      2,
      f.create as unknown as () => HTMLCanvasElement,
    ) as CanvasSnapshot;
    const outCanvas = f.created[0];
    expect(outCanvas.width).toBe(600); // 300 × 2
    expect(outCanvas.height).toBe(400); // 200 × 2
    const ctx = outCanvas.ctx;
    // both layers blitted at rect × dpr: base first, then overlay (crosshair) over it.
    const di = ctx.ops('drawImage');
    expect(di).toHaveLength(2);
    expect(di[0].args).toEqual([snap.base, 20, 10, 200, 80]);
    expect(di[1].args).toEqual([snap.overlay, 20, 10, 200, 80]);
    // fill tile drawn as a rect × dpr
    const fr = ctx.ops('fillRect')[0];
    expect(fr.args.slice(0, 4)).toEqual([0, 0, 16, 400]);
    // toCanvas exposes the underlying canvas
    expect(out.toCanvas()).toBe(outCanvas);
  });

  test('includeCrosshair=false composes the BASE layer only (overlay/crosshair omitted)', () => {
    const f = fakeFactory();
    const snap = tileSnapshot(200, 80);
    const tiles: SnapshotTile[] = [{ rect: { x: 0, y: 0, width: 100, height: 40 }, snapshot: snap }];
    composeSnapshot(tiles, { width: 100, height: 40 }, 1, f.create as unknown as () => HTMLCanvasElement, false);
    const di = f.created[0].ctx.ops('drawImage');
    // only the base layer; the overlay (crosshair band, §5.2) is skipped.
    expect(di).toHaveLength(1);
    expect(di[0].args[0]).toBe(snap.base);
  });

  test('includeCrosshair defaults to true (both layers) when the arg is omitted', () => {
    const f = fakeFactory();
    const snap = tileSnapshot(50, 50);
    composeSnapshot(
      [{ rect: { x: 0, y: 0, width: 50, height: 50 }, snapshot: snap }],
      { width: 50, height: 50 },
      1,
      f.create as unknown as () => HTMLCanvasElement,
    );
    expect(f.created[0].ctx.ops('drawImage')).toHaveLength(2);
  });

  test('a zero-size (degenerate) snapshot tile is skipped — no drawImage (the 0×0 guard, §5.1.5)', () => {
    const f = fakeFactory();
    const snap = tileSnapshot(0, 80); // zero width ⇒ degenerate
    composeSnapshot(
      [{ rect: { x: 0, y: 0, width: 100, height: 40 }, snapshot: snap }],
      { width: 100, height: 40 },
      1,
      f.create as unknown as () => HTMLCanvasElement,
    );
    expect(f.created[0].ctx.ops('drawImage')).toHaveLength(0);
  });

  test('toBlob delegates to the canvas toBlob', async () => {
    const f = fakeFactory();
    const out = composeSnapshot([], { width: 10, height: 10 }, 1, f.create as unknown as () => HTMLCanvasElement) as CanvasSnapshot;
    const canvas = f.created[0] as unknown as { toBlob: (cb: (b: Blob | null) => void) => void };
    canvas.toBlob = vi.fn((cb: (b: Blob | null) => void) => cb(new Blob(['x'])));
    const blob = await out.toBlob();
    expect(blob).toBeInstanceOf(Blob);
  });
});
