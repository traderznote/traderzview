// Per-canvas bitmap binding — the rewritten fancy-canvas logic (design 03 §8.2,
// R12; study 05 §3.2/§4.2 is the spec of record). `fancy-canvas` is not a
// dependency (01 §13.9). Responsibilities:
//   - setMediaSize writes style.width/height (never reads layout back);
//   - bitmap discovery via an injected BitmapObserver (device-pixel-content-box
//     ResizeObserver preferred; matchMedia + prediction fallback);
//   - discovered sizes clamped per-dimension to ≥ client size, stored as a
//     SUGGESTION, and resolutionChanged fired (the content-destroying
//     canvas.width/height write happens ONLY in applySuggested, called from
//     beginFrame('full'));
//   - on the matchMedia fallback, setMediaSize itself re-predicts (a pure CSS
//     resize at the same DPR would otherwise never refresh the bitmap);
//   - dispose: shrink to 1×1 + clear (iOS canvas-memory cap).
// NO _isSettingSize reentrancy flag: the binding only fires an event; mask
// coalescing absorbs storms (structural fix, R12). 01 §5.1.5 degenerate-size
// handling lives in the surface, which pins ratio=1 per zeroed axis.
import type { ISubscription, Size } from '../core';
import { Emitter } from '../core';

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * The bitmap-discovery strategy, injected so the binding is testable headless.
 * `reprediction` is true on the matchMedia fallback (setMediaSize must re-predict),
 * false on the device-pixel-content-box ResizeObserver path (it fires on CSS resize).
 */
export interface BitmapObserver {
  readonly reprediction: boolean;
  start(onDiscovered: (bitmapW: number, bitmapH: number) => void): void;
  dispose(): void;
}

/**
 * Predict a bitmap size from a client rect + device pixel ratio (study 05 §3.2):
 * snap both physical edges to the pixel grid and take the difference. Models how
 * the browser rasterizes a box whose CSS edges land between physical pixels.
 */
export function predictBitmapSize(rect: ClientRect, dpr: number): Size {
  const width = Math.round(rect.left * dpr + rect.width * dpr) - Math.round(rect.left * dpr);
  const height = Math.round(rect.top * dpr + rect.height * dpr) - Math.round(rect.top * dpr);
  return { width, height };
}

export class CanvasBinding {
  readonly #canvas: HTMLCanvasElement;
  readonly #observer: BitmapObserver;
  readonly #getDpr: () => number;
  readonly #getClientRect: (() => ClientRect) | undefined;
  readonly #resolutionChanged = new Emitter();

  #clientSize: Size = { width: 0, height: 0 };
  #bitmapSize: Size = { width: 0, height: 0 };
  #suggested: Size | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    observer: BitmapObserver,
    getDpr: () => number = () => 1,
    getClientRect?: () => ClientRect,
  ) {
    this.#canvas = canvas;
    this.#observer = observer;
    this.#getDpr = getDpr;
    this.#getClientRect = getClientRect;
    this.#observer.start((w, h) => this.#discover(w, h));
  }

  get resolutionChanged(): ISubscription {
    return this.#resolutionChanged;
  }

  get bitmapSize(): Size {
    return this.#bitmapSize;
  }

  get suggestedBitmapSize(): Size | undefined {
    return this.#suggested;
  }

  setMediaSize(size: Size): void {
    this.#clientSize = { width: size.width, height: size.height };
    this.#canvas.style.width = `${size.width}px`;
    this.#canvas.style.height = `${size.height}px`;
    // Fallback path only: a pure CSS resize at the same DPR never fires matchMedia,
    // so re-derive the bitmap here (mirrors fancy-canvas re-measuring on every resize).
    if (this.#observer.reprediction) {
      const rect = this.#getClientRect ? this.#getClientRect() : { left: 0, top: 0, ...size };
      const p = predictBitmapSize(rect, this.#getDpr());
      this.#discover(p.width, p.height);
    }
  }

  #discover(rawW: number, rawH: number): void {
    // Clamp per-dimension to ≥ client size (sub-1-DPR / transient-0 protection).
    const final: Size = {
      width: Math.max(rawW, this.#clientSize.width),
      height: Math.max(rawH, this.#clientSize.height),
    };
    const target = this.#suggested ?? this.#bitmapSize;
    if (final.width === target.width && final.height === target.height) return;
    if (final.width === this.#bitmapSize.width && final.height === this.#bitmapSize.height) {
      // Discovery matches the already-applied bitmap → drop any stale suggestion.
      this.#suggested = undefined;
      return;
    }
    this.#suggested = final;
    this.#resolutionChanged.fire();
  }

  /** Apply a pending suggestion (content-destroying). Called only in beginFrame('full'). */
  applySuggested(): Size {
    const s = this.#suggested;
    if (s === undefined) return this.#bitmapSize;
    this.#suggested = undefined;
    if (s.width !== this.#bitmapSize.width || s.height !== this.#bitmapSize.height) {
      this.#canvas.width = s.width; // destroys content
      this.#canvas.height = s.height;
      this.#bitmapSize = s;
    }
    return this.#bitmapSize;
  }

  dispose(): void {
    this.#observer.dispose();
    this.#resolutionChanged.dispose();
    // iOS Safari canvas-memory cap: shrink to 1×1 and clear before removal.
    this.#canvas.width = 1;
    this.#canvas.height = 1;
    const ctx = this.#canvas.getContext('2d');
    if (ctx !== null) ctx.clearRect(0, 0, 1, 1);
  }
}
