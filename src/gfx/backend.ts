// The renderer backend contract (architecture §5.2). gfx owns these interfaces;
// backend-canvas (M6) implements them and a GPU backend (post-v1) implements the
// same surface. Nothing here knows what a candlestick is — backends consume the
// draw-command vocabulary only. Type declarations; no runtime.
import type { ISubscription, Rect, Size } from '../core';
import type { DisplayList, ImageHandle } from './commands';
import type { ITextMeasurer } from './text-measure';

export type LayerId = 'base' | 'overlay';
export type FrameScope = 'overlay' | 'full';

export interface FrameInfo {
  mediaSize: Size;
  bitmapSize: Size;
  hr: number; // bitmap/media per axis; fractional and asymmetric are normal
  vr: number;
}

// Opaque backend handles — created by the backend, never inspected outside it.
export interface SurfaceSnapshot {
  readonly _tag?: 'SurfaceSnapshot';
}
/** Public opaque screenshot type; backend-canvas adds toCanvas()/toBlob() adapters. */
export interface Snapshot {
  readonly _tag?: 'Snapshot';
}

// A screenshot tile: a surface snapshot, or a solid fill (surface-less DOM chrome
// like pane separators, which must still appear in screenshots).
export type SnapshotTile = { rect: Rect } & ({ snapshot: SurfaceSnapshot } | { fill: string });

export interface ISurface {
  setMediaSize(size: Size): void; // CSS px; backend owns bitmap size
  beginFrame(scope: FrameScope): FrameInfo; // 'full' applies pending bitmap resize; 'overlay' never
  renderLayer(layer: LayerId, lists: readonly DisplayList[]): void; // replaces the layer
  endFrame(): void;
  readonly resolutionChanged: ISubscription; // DPR / sub-pixel bitmap change
  snapshot(): SurfaceSnapshot;
  dispose(): void;
}

export interface IRenderBackend<TMount = unknown, TImageSrc = unknown> {
  createSurface(mount: TMount): ISurface;
  createImage(source: TImageSrc): ImageHandle;
  composeSnapshot(tiles: readonly SnapshotTile[], mediaSize: Size): Snapshot;
  readonly text: ITextMeasurer;
  dispose(): void;
}
