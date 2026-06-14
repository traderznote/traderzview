// The price-axis manual-interaction state machine (architecture §4.6; study 04
// §4.7/§4.8/§3.4 are the spec of record). Owns DRAG STATE ONLY — the recognizer
// that starts/feeds it is host/input (§7), and double-click reset is an
// InteractionRouter action (§9.1), NOT here. Mirrors time-scale/navigator.ts.
//
// ONE shared range-snapshot slot: startScale and startScroll write the same
// `#snapshot`, so a scale-in-progress blocks a scroll-start and vice versa.
import { refusesManualScale, type MinMax, type PriceScaleMode } from './modes';

const SCALE_DAMPING = 0.2; // the 0.2·height damping constant (study 04 §4.8)
const SCALE_COEFF_FLOOR = 0.1; // caps zoom-in at 10× per gesture; zoom-out unbounded

export interface PriceNavigatorInit {
  range: MinMax | null;
  autoScale: boolean;
  mode: PriceScaleMode;
  inverted: boolean;
  height: number; // internal band height h (margins already removed by the caller)
}

export class PriceNavigator {
  #range: MinMax | null;
  #autoScale: boolean;
  #mode: PriceScaleMode;
  #inverted: boolean;
  #height: number;
  #snapshot: MinMax | null = null; // the ONE shared slot
  #scaleStart: number | null = null;
  #scrollStart: number | null = null;
  #scaledThisGesture = false;

  constructor(init: PriceNavigatorInit) {
    this.#range = init.range;
    this.#autoScale = init.autoScale;
    this.#mode = init.mode;
    this.#inverted = init.inverted;
    this.#height = init.height;
  }

  range(): MinMax | null {
    return this.#range;
  }
  isAutoScale(): boolean {
    return this.#autoScale;
  }
  setMode(mode: PriceScaleMode): void {
    this.#mode = mode;
  }
  setRange(range: MinMax | null): void {
    this.#range = range;
  }
  setAutoScale(on: boolean): void {
    this.#autoScale = on;
  }

  // --- scale (axis drag-zoom) ---------------------------------------------------

  startScale(y: number): void {
    if (refusesManualScale(this.#mode)) return; // percent/indexed have no absolute range
    if (this.#snapshot !== null || this.#scaleStart !== null) return; // a gesture is live
    if (this.#range === null) return; // empty scale
    this.#scaleStart = this.#height - y;
    this.#snapshot = { ...this.#range };
    this.#scaledThisGesture = false;
  }

  scaleTo(y: number): void {
    if (refusesManualScale(this.#mode)) return;
    if (this.#scaleStart === null || this.#snapshot === null) return; // no start recorded
    if (!this.#scaledThisGesture) {
      this.#autoScale = false; // a manual scale always pins the range (first move)
      this.#scaledThisGesture = true;
    }
    const x = Math.max(0, this.#height - y);
    const damp = (this.#height - 1) * SCALE_DAMPING;
    let coeff = (this.#scaleStart + damp) / (x + damp);
    coeff = Math.max(coeff, SCALE_COEFF_FLOOR);
    const snap = this.#snapshot;
    const length = snap.max - snap.min;
    if (length === 0 || !Number.isFinite(coeff)) return;
    const center = (snap.min + snap.max) / 2;
    const half = (length / 2) * coeff;
    this.#range = { min: center - half, max: center + half };
  }

  endScale(): void {
    if (refusesManualScale(this.#mode)) return;
    this.#scaleStart = null;
    this.#snapshot = null;
    this.#scaledThisGesture = false;
  }

  // --- scroll (axis drag-pan) ---------------------------------------------------
  // All three entry points return immediately when autoscale is on (study 04 §3.4).

  startScroll(y: number): void {
    if (this.#autoScale) return;
    if (this.#snapshot !== null || this.#scrollStart !== null) return;
    if (this.#range === null) return;
    this.#scrollStart = y;
    this.#snapshot = { ...this.#range };
  }

  scrollTo(y: number): void {
    if (this.#autoScale) return;
    if (this.#scrollStart === null || this.#snapshot === null) return;
    const snap = this.#snapshot;
    const length = snap.max - snap.min;
    let shift = (y - this.#scrollStart) * (length / (this.#height - 1));
    if (this.#inverted) shift = -shift;
    // FORCE-set a new range object even on an equal range, so dependent caches
    // refresh (study 04 §3.3/§4.8).
    this.#range = { min: snap.min + shift, max: snap.max + shift };
  }

  endScroll(): void {
    if (this.#autoScale) return;
    this.#scrollStart = null;
    this.#snapshot = null;
  }
}
