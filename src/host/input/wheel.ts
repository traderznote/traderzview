// traderzview · host/input — mouse-wheel normalization (study 10 §4.4 / study 07
// §4.4 / design 04 §7). ONE pure function: a WheelEvent-like → { scroll, zoom }.
// Getting any factor wrong changes feel ~100× (perf §7), so the constants live
// here, named, with a golden-value test. No DOM, no state: callable headless.

// deltaMode codes (WheelEvent.DOM_DELTA_*). Kept local so this file is lib.dom-free.
const DELTA_MODE_PIXEL = 0;
const DELTA_MODE_LINE = 1;
const DELTA_MODE_PAGE = 2;

/** Per-notch normalization factors (study 10 §4.4): one page / one line of delta. */
export const WHEEL_DELTA_PAGE = 120;
export const WHEEL_DELTA_LINE = 32;
const SCROLL_COEFF = -80; // empirical px-per-unit; minus = natural scroll
const DELTA_DIVISOR = 100; // the /100 applied to BOTH axes

/** A normalized WheelEvent: only the four fields the §4.4 pipeline reads. */
export interface WheelLike {
  deltaMode: number; // 0 PIXEL | 1 LINE | 2 PAGE
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
}

/** Post-normalization wheel deltas (§4.4). `scroll` is horizontal px; `zoom` is a
 *  ±1-clamped zoom step; `ctrlKey` passes through so the DOM-wiring can treat
 *  ctrl+vertical as a zoom intent (the §13.5 wheelDelta channel). */
export interface NormalizedWheel {
  scroll: number;
  zoom: number;
  ctrlKey: boolean;
}

const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/**
 * Normalize a wheel event to { scroll, zoom } (study 10 §4.4):
 *   adj = 120 PAGE | 32 LINE | 1 PIXEL  (PIXEL → 1/dpr on Windows-Chromium, bug 1001735)
 *   dx  =  adj * deltaX / 100 * speed;  dy = -(adj * deltaY / 100) * speed
 *   zoom   = sign(dy) * min(1, |dy|)     (±1 clamp per event)
 *   scroll = dx * -80
 * `speed` is the user-facing wheel-speed multiplier (architecture §7); defaults 1.
 */
export function normalizeWheel(
  e: WheelLike,
  speed = 1,
  windowsChromium = false,
  dpr = 1,
): NormalizedWheel {
  let adj: number;
  if (e.deltaMode === DELTA_MODE_PAGE) adj = WHEEL_DELTA_PAGE;
  else if (e.deltaMode === DELTA_MODE_LINE) adj = WHEEL_DELTA_LINE;
  else adj = windowsChromium ? 1 / dpr : 1; // PIXEL
  void DELTA_MODE_PIXEL; // documents the third code; PIXEL is the fall-through branch

  const dx = (adj * e.deltaX) / DELTA_DIVISOR * speed;
  const dy = (-(adj * e.deltaY) / DELTA_DIVISOR) * speed;
  return {
    scroll: dx !== 0 ? dx * SCROLL_COEFF : 0,
    zoom: dy !== 0 ? sign(dy) * Math.min(1, Math.abs(dy)) : 0,
    ctrlKey: e.ctrlKey,
  };
}
