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

/**
 * A surface snapshot keeps its TWO layers as SEPARATE detached offscreen canvases
 * (base below, overlay above) rather than pre-flattening them into one. Two reasons:
 *   1. composeSnapshot decides per screenshot whether to paint the overlay — the
 *      crosshair / cursor / overlay-label bands all live in the overlay layer (§5.2),
 *      so an `includeCrosshair: false` screenshot is "base only". Keeping the layers
 *      apart is what makes that toggle a one-pass compose (§8.6).
 *   2. The live surface canvases are cleared+repainted every frame; copying into fresh
 *      offscreen canvases here detaches the snapshot so a later frame can't corrupt it.
 */
export interface CanvasSurfaceSnapshot extends SurfaceSnapshot {
  readonly base: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly size: Size;
}

/** Copy a surface's two layers into detached offscreen canvases (§8.6). */
export function makeSurfaceSnapshot(
  base: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  bitmapSize: Size,
  createCanvas: () => HTMLCanvasElement,
): CanvasSurfaceSnapshot {
  const baseCopy = createCanvas();
  const overlayCopy = createCanvas();
  baseCopy.width = overlayCopy.width = bitmapSize.width;
  baseCopy.height = overlayCopy.height = bitmapSize.height;
  // Degenerate (0-dim) surfaces produce zero-size copies; drawImage of/into 0×0 throws
  // in some browsers, so skip the blits (study 05 §5 guard, kept).
  if (bitmapSize.width > 0 && bitmapSize.height > 0) {
    copyLayer(baseCopy, base);
    copyLayer(overlayCopy, overlay);
  }
  return { base: baseCopy, overlay: overlayCopy, size: bitmapSize };
}

function copyLayer(dst: HTMLCanvasElement, src: HTMLCanvasElement): void {
  const ctx = dst.getContext('2d');
  if (ctx !== null) ctx.drawImage(src, 0, 0);
}

/** The public opaque Snapshot, with the canvas-specific export adapters. */
export interface CanvasSnapshot extends Snapshot {
  toCanvas(): HTMLCanvasElement;
  toBlob(type?: string, quality?: number): Promise<Blob | null>;
}

/**
 * Single pass over the screenshot tiles onto one output canvas at `mediaSize × dpr`
 * (§8.6). The host hands the tiles in paint order (surfaces first, then separator fill
 * tiles painted over the top), so this just walks them once — no measure/draw split
 * (study 10 CUT). Per tile:
 *   - SNAPSHOT tile → blit its layers into `rect × dpr`: always the base layer, then
 *     the overlay layer ONLY when `includeCrosshair` (the crosshair/cursor/overlay-label
 *     bands live in overlay, §5.2). Zero-size (degenerate) snapshots are skipped — the
 *     drawImage-of-0×0 guard (§5.1.5).
 *   - FILL tile → a solid `fillRect` of `rect × dpr` (the 1-px pane separators, which are
 *     surface-less DOM divs and would otherwise be holes in the screenshot, §3.4 / 01 §7).
 * `includeCrosshair` defaults to true — a screenshot includes the crosshair unless the
 * caller opts out.
 */
export function composeSnapshot(
  tiles: readonly SnapshotTile[],
  mediaSize: Size,
  dpr: number,
  createCanvas: () => HTMLCanvasElement,
  includeCrosshair = true,
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
          ctx.drawImage(surf.base, dx, dy, dw, dh);
          if (includeCrosshair) ctx.drawImage(surf.overlay, dx, dy, dw, dh);
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
