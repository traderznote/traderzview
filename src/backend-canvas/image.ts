// Image handles + snapshot composition (design 03 §8.1, §8.6). createImage wraps a
// CanvasImageSource (no decode — the producer loaded it) and records its natural
// size. Snapshots: per-surface = base+overlay flattened onto one offscreen canvas;
// composeSnapshot = one pass over tiles onto a mediaSize × dpr output canvas, the
// public opaque Snapshot carrying toCanvas()/toBlob() adapters. The host already
// knows every rect from computeLayout, so this replaces the reference's dual
// measure/draw traversal (study 10 CUT).
import type { Size } from '../core';
import type { ImageHandle, Snapshot, SnapshotTile, SurfaceSnapshot } from '../gfx';

/** A CanvasImageSource lacks a uniform size accessor; probe the three shapes. */
export function naturalSize(source: CanvasImageSource): Size {
  const s = source as unknown as Record<string, number>;
  if (typeof s.naturalWidth === 'number') return { width: s.naturalWidth, height: s.naturalHeight };
  if (typeof s.videoWidth === 'number') return { width: s.videoWidth, height: s.videoHeight };
  return { width: s.width, height: s.height };
}

export interface CanvasImageHandle extends ImageHandle {
  readonly source: CanvasImageSource;
}

export function createCanvasImage(source: CanvasImageSource): CanvasImageHandle {
  let live: CanvasImageSource | undefined = source;
  const size = naturalSize(source);
  return {
    size,
    get source(): CanvasImageSource {
      return live as CanvasImageSource;
    },
    dispose(): void {
      live = undefined; // drop the reference; decoding/loading was never ours
    },
  };
}

/** A flattened (base+overlay) bitmap of one surface. */
export interface CanvasSurfaceSnapshot extends SurfaceSnapshot {
  readonly canvas: HTMLCanvasElement;
  readonly size: Size;
}

/** Flatten a surface's two layers into one offscreen canvas at its bitmap size. */
export function makeSurfaceSnapshot(
  base: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  bitmapSize: Size,
  createCanvas: () => HTMLCanvasElement,
): CanvasSurfaceSnapshot {
  const canvas = createCanvas();
  canvas.width = bitmapSize.width;
  canvas.height = bitmapSize.height;
  // Degenerate (0-dim) surfaces produce a zero-size snapshot; drawImage of/into 0×0
  // throws in some browsers, so skip the blits (study 05 §5 guard, kept).
  if (bitmapSize.width > 0 && bitmapSize.height > 0) {
    const ctx = canvas.getContext('2d');
    if (ctx !== null) {
      ctx.drawImage(base, 0, 0);
      ctx.drawImage(overlay, 0, 0);
    }
  }
  return { canvas, size: bitmapSize };
}

/** The public opaque Snapshot, with the canvas-specific export adapters. */
export interface CanvasSnapshot extends Snapshot {
  toCanvas(): HTMLCanvasElement;
  toBlob(type?: string, quality?: number): Promise<Blob | null>;
}

export function composeSnapshot(
  tiles: readonly SnapshotTile[],
  mediaSize: Size,
  dpr: number,
  createCanvas: () => HTMLCanvasElement,
): CanvasSnapshot {
  const canvas = createCanvas();
  canvas.width = Math.round(mediaSize.width * dpr);
  canvas.height = Math.round(mediaSize.height * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    for (const tile of tiles) {
      const r = tile.rect;
      const dx = r.x * dpr;
      const dy = r.y * dpr;
      const dw = r.width * dpr;
      const dh = r.height * dpr;
      if ('fill' in tile) {
        ctx.fillStyle = tile.fill;
        ctx.fillRect(dx, dy, dw, dh);
      } else {
        const surf = tile.snapshot as CanvasSurfaceSnapshot;
        if (surf.size.width > 0 && surf.size.height > 0) {
          ctx.drawImage(surf.canvas, dx, dy, dw, dh);
        }
      }
    }
  }
  return {
    toCanvas: () => canvas,
    toBlob: (type?: string, quality?: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), type, quality)),
  };
}
