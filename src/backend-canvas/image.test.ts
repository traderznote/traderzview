// Runs headless in node (no jsdom): the mock canvas stands in for the offscreen
// canvas, so composeSnapshot's blit math is asserted against the recording log.
import { describe, expect, test, vi } from 'vitest';
import type { SnapshotTile, SurfaceSnapshot } from '../gfx';
import { composeSnapshot, createCanvasImage, naturalSize, type CanvasSnapshot } from './image';
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

  test('output canvas sized mediaSize × dpr; snapshot tiles drawn into rect×dpr; fill tiles filled', () => {
    const f = fakeFactory();
    const tileCanvas = new MockCanvas();
    const snap: SurfaceSnapshot & { canvas: MockCanvas; size: { width: number; height: number } } = {
      canvas: tileCanvas,
      size: { width: 200, height: 80 },
    } as never;
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
    // snapshot tile blitted at rect × dpr
    const di = ctx.ops('drawImage')[0];
    expect(di.args).toEqual([tileCanvas, 20, 10, 200, 80]);
    // fill tile drawn as a rect × dpr
    const fr = ctx.ops('fillRect')[0];
    expect(fr.args.slice(0, 4)).toEqual([0, 0, 16, 400]);
    // toCanvas exposes the underlying canvas
    expect(out.toCanvas()).toBe(outCanvas);
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
