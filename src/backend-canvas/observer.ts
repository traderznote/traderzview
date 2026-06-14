// Real BitmapObserver strategies (design 03 §8.2). Two paths, chosen per canvas by
// a synchronous feature probe of ResizeObserverEntry: the preferred
// device-pixel-content-box ResizeObserver (exact physical pixels, fires on CSS
// resize) and the matchMedia fallback (reinstall-after-every-fire DPR observable;
// the binding re-predicts in setMediaSize on this path). Lives apart from binding.ts
// so the binding stays headless-testable with a fake observer.
import type { BitmapObserver, ClientRect } from './binding';

/** True iff this engine exposes devicePixelContentBoxSize on ResizeObserverEntry. */
function supportsDevicePixelContentBox(): boolean {
  if (typeof ResizeObserver === 'undefined' || typeof ResizeObserverEntry === 'undefined') return false;
  // The entry field is the capability signal: present iff the browser can report the
  // device-pixel content box (the entry shape Chromium/Firefox expose; absent on
  // older WebKit, which then takes the matchMedia fallback). At runtime the observer
  // also guards on a missing field, so this probe only selects the strategy.
  const proto = ResizeObserverEntry.prototype as object;
  return 'devicePixelContentBoxSize' in proto;
}

/** ResizeObserver(device-pixel-content-box) path — preferred, exact, no prediction. */
class ResizeObserverStrategy implements BitmapObserver {
  readonly reprediction = false;
  readonly #canvas: HTMLCanvasElement;
  #ro: ResizeObserver | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  start(onDiscovered: (w: number, h: number) => void): void {
    this.#ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.devicePixelContentBoxSize?.[0];
        if (box) onDiscovered(box.inlineSize, box.blockSize);
      }
    });
    this.#ro.observe(this.#canvas, { box: 'device-pixel-content-box' });
  }

  dispose(): void {
    this.#ro?.disconnect();
    this.#ro = undefined;
  }
}

/** matchMedia DPR observable with reinstall-after-fire + edge-snapped prediction. */
class MatchMediaStrategy implements BitmapObserver {
  readonly reprediction = true;
  readonly #canvas: HTMLCanvasElement;
  #mql: MediaQueryList | undefined;
  #handler: (() => void) | undefined;
  #onDiscovered: ((w: number, h: number) => void) | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  start(onDiscovered: (w: number, h: number) => void): void {
    this.#onDiscovered = onDiscovered;
    this.#install();
    this.#predict(); // once at init
  }

  #install(): void {
    const dpr = devicePixelRatio();
    this.#mql = matchMedia(`(resolution: ${dpr}dppx)`);
    this.#handler = () => {
      // matchMedia matches one resolution; reinstall with the new value after it fires.
      this.#teardownListener();
      this.#install();
      this.#predict();
    };
    this.#mql.addEventListener('change', this.#handler);
  }

  #predict(): void {
    const r = this.#canvas.getBoundingClientRect();
    const rect: ClientRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    const dpr = devicePixelRatio();
    // Reuse the binding's formula via inline computation to avoid a cycle.
    const w = Math.round(rect.left * dpr + rect.width * dpr) - Math.round(rect.left * dpr);
    const h = Math.round(rect.top * dpr + rect.height * dpr) - Math.round(rect.top * dpr);
    this.#onDiscovered?.(w, h);
  }

  #teardownListener(): void {
    if (this.#mql && this.#handler) this.#mql.removeEventListener('change', this.#handler);
  }

  dispose(): void {
    this.#teardownListener();
    this.#mql = undefined;
    this.#handler = undefined;
  }
}

/** window.devicePixelRatio, defaulting to 1 where absent. Never crosses the seam. */
export function devicePixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

/** Pick the discovery strategy for a canvas (probe once). */
export function makeBitmapObserver(canvas: HTMLCanvasElement): BitmapObserver {
  return supportsDevicePixelContentBox()
    ? new ResizeObserverStrategy(canvas)
    : new MatchMediaStrategy(canvas);
}
