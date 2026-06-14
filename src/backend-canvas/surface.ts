// ISurface (design 03 §5, §8.2, §8.6): one mount div with two stacked canvases
// (base below, overlay above — the reference's two-canvas scheme, study 05 §6).
// beginFrame('full') applies the pending bitmap resize on BOTH canvases; 'overlay'
// never resizes (R7 — an overlay frame cannot destroy base pixels by construction).
// renderLayer replaces the layer (implicit clear + replay in array order, §5.1.2);
// renderLayer('base') inside an 'overlay' scope is a dev-assert/no-op (§5.1.3). A
// degenerate 0-dim surface returns finite FrameInfo (ratio 1 per zeroed axis, never
// NaN — §5.1.5) and silently no-ops render/end/snapshot (the drawImage-0×0 guard).
import { assert } from '../core';
import type { ISubscription, Size } from '../core';
import { Emitter } from '../core';
import type { DisplayList, FrameInfo, FrameScope, LayerId, SurfaceSnapshot } from '../gfx';
import type { CanvasBinding } from './binding';
import { GradientCache } from './gradient';
import { makeSurfaceSnapshot } from './image';
import { replayLists } from './replay';

export interface CanvasSurfaceDeps {
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  baseBinding: CanvasBinding;
  overlayBinding: CanvasBinding;
  createCanvas: () => HTMLCanvasElement;
  colorSpace: PredefinedColorSpace;
  onDispose?: () => void;
}

export class CanvasSurface {
  readonly #deps: CanvasSurfaceDeps;
  readonly #resolutionChanged = new Emitter();
  readonly #baseCache = new GradientCache();
  readonly #overlayCache = new GradientCache();

  #mediaSize: Size = { width: 0, height: 0 };
  #bitmapSize: Size = { width: 0, height: 0 };
  #scope: FrameScope | undefined; // set between beginFrame and endFrame

  constructor(deps: CanvasSurfaceDeps) {
    this.#deps = deps;
    // Surface aggregates both bindings' resolutionChanged into one signal (01 §5.2 →
    // the host maps it to one coalescing Layout mask).
    deps.baseBinding.resolutionChanged.subscribe(() => this.#resolutionChanged.fire(), { owner: this });
    deps.overlayBinding.resolutionChanged.subscribe(() => this.#resolutionChanged.fire(), { owner: this });
  }

  get resolutionChanged(): ISubscription {
    return this.#resolutionChanged;
  }

  setMediaSize(size: Size): void {
    this.#mediaSize = { width: size.width, height: size.height };
    this.#deps.baseBinding.setMediaSize(size);
    this.#deps.overlayBinding.setMediaSize(size);
  }

  beginFrame(scope: FrameScope): FrameInfo {
    this.#scope = scope;
    if (scope === 'full') {
      // Destructive bitmap resizes are applied ONLY here (§5.1.4). Both canvases are
      // kept the same size by the host; the base (main) canvas is authoritative.
      this.#bitmapSize = this.#deps.baseBinding.applySuggested();
      this.#deps.overlayBinding.applySuggested();
    }
    const m = this.#mediaSize;
    const b = this.#bitmapSize;
    // Degenerate axis: hr=bitmap/media would be 0/0=NaN, so pin to 1 (§5.1.5).
    const hr = m.width === 0 ? 1 : b.width / m.width;
    const vr = m.height === 0 ? 1 : b.height / m.height;
    return { mediaSize: { ...m }, bitmapSize: { ...b }, hr, vr };
  }

  renderLayer(layer: LayerId, lists: readonly DisplayList[]): void {
    if (layer === 'base' && this.#scope === 'overlay') {
      // Contract violation (§5.1.3): overlay scope must not touch the base bitmap.
      assert(false, "renderLayer('base') is illegal inside beginFrame('overlay')");
      return; // no-op in prod
    }
    if (this.#isDegenerate()) return; // §5.1.5 — drawImage/getContext-of-0 guard
    const canvas = layer === 'base' ? this.#deps.baseCanvas : this.#deps.overlayCanvas;
    const cache = layer === 'base' ? this.#baseCache : this.#overlayCache;
    const ctx = canvas.getContext('2d', { colorSpace: this.#deps.colorSpace });
    if (ctx === null) return;
    const m = this.#mediaSize;
    const b = this.#bitmapSize;
    const hr = m.width === 0 ? 1 : b.width / m.width;
    const vr = m.height === 0 ? 1 : b.height / m.height;
    replayLists(ctx, lists, b.width, b.height, hr, vr, cache);
  }

  endFrame(): void {
    this.#scope = undefined;
  }

  snapshot(): SurfaceSnapshot {
    return makeSurfaceSnapshot(
      this.#deps.baseCanvas,
      this.#deps.overlayCanvas,
      { ...this.#bitmapSize },
      this.#deps.createCanvas,
    );
  }

  dispose(): void {
    this.#resolutionChanged.dispose();
    this.#deps.baseBinding.dispose();
    this.#deps.overlayBinding.dispose();
    this.#deps.onDispose?.();
  }

  #isDegenerate(): boolean {
    return (
      this.#mediaSize.width === 0 ||
      this.#mediaSize.height === 0 ||
      this.#bitmapSize.width === 0 ||
      this.#bitmapSize.height === 0
    );
  }
}
