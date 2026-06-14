// The crisp-pixel rule set (design 03 §4.2), encoded ONCE as pure functions so
// reference-grade crispness is testable with plain numbers and no canvas. Emitters
// produce bitmap-space coordinates with these; backends draw them verbatim.
// Bodies are coded from study 05 §4.4 and study 06 §4.8 (the spec of record).

/** Line width: `max(1, floor(mediaWidth · ratio))` — never 0, never fractional. */
export function crispWidth(mediaWidth: number, ratio: number): number {
  return Math.max(1, Math.floor(mediaWidth * ratio));
}

/** Round a coordinate into device space: `round(coord · ratio)`. */
export function crispRound(coord: number, ratio: number): number {
  return Math.round(coord * ratio);
}

/**
 * Stroke position with the odd-width half-pixel shift. The third arg is the
 * parity reference — the LINE's bitmap width (e.g. crispWidth(lineWidth, ratio)),
 * NOT the surface width (design 03 §4.2 / study 05 §4.4).
 */
export function crispStrokePos(coord: number, ratio: number, lineBitmapWidth: number): number {
  return Math.round(coord * ratio) + (lineBitmapWidth % 2 ? 0.5 : 0);
}

export interface TickRect {
  pos: number;
  thickness: number;
  length: number;
}

/**
 * A tick/border drawn as a filled rect instead of a stroke (study 05 §4.4):
 * `pos = round(coord·ratio) − floor(ratio·0.5)` recentres on the logical
 * coordinate; `thickness = max(1, floor(ratio))`. `length` is the cross-axis
 * extent, passed through for the caller's rect.
 */
export function tickRect(coord: number, ratio: number, length: number): TickRect {
  return {
    pos: Math.round(coord * ratio) - Math.floor(ratio * 0.5),
    thickness: Math.max(1, Math.floor(ratio)),
    length,
  };
}

export interface EdgeRect {
  x: number;
  w: number;
}

/** Inclusive-edge bitmap convention (study 10 §5): `w = right − left + 1`. */
export function edgeToRect(left: number, right: number): EdgeRect {
  return { x: left, w: right - left + 1 };
}

/** Bar-series body width: `floor(barSpacing · 0.3 · ratio)` (study 06 §4.8). */
export function optimalBarWidth(barSpacing: number, ratio: number): number {
  return Math.floor(barSpacing * 0.3 * ratio);
}

/**
 * Candlestick body width (study 06 §4.8 — verbatim): a 2.5–4 spacing plateau at
 * `floor(3·ratio)`, otherwise an atan taper from 1·spacing toward 0.8·spacing,
 * clamped into `[floor(ratio), floor(barSpacing·ratio)]`.
 */
export function optimalCandlestickWidth(barSpacing: number, ratio: number): number {
  if (barSpacing >= 2.5 && barSpacing <= 4) {
    return Math.floor(3 * ratio);
  }
  const coeff = 1 - (0.2 * Math.atan(Math.max(4, barSpacing) - 4)) / (Math.PI * 0.5);
  const res = Math.floor(barSpacing * coeff * ratio);
  return Math.max(Math.floor(ratio), Math.min(res, Math.floor(barSpacing * ratio)));
}

/**
 * Parity rule (study 06 §4.8): if the bar width is ≥ 2 and its parity differs
 * from the crosshair/grid reference line width, shrink it by 1 so a centered
 * crosshair bisects the bar symmetrically. Callers pass their own reference width
 * (bars: `max(1, floor(hr))`; candles: `floor(hr)` — they diverge for ratio < 1).
 */
export function applyBarParity(width: number, refLineWidth: number): number {
  if (width >= 2 && width % 2 !== refLineWidth % 2) {
    return width - 1;
  }
  return width;
}

/** Largest even number ≤ x (even-size layout hint, consumed by host computeLayout). */
export function evenFloor(x: number): number {
  return 2 * Math.floor(x / 2);
}

/** Smallest even number ≥ x. */
export function evenCeil(x: number): number {
  return 2 * Math.ceil(x / 2);
}

/** `ceil(x)` made odd by subtracting 1 if even — shrinks, never grows (study 08 §4.4). */
export function ceiledOdd(x: number): number {
  const c = Math.ceil(x);
  return c % 2 === 0 ? c - 1 : c;
}

/** `ceil(x)` made even by subtracting 1 if odd — shrinks, never grows (study 08 §4.4). */
export function ceiledEven(x: number): number {
  const c = Math.ceil(x);
  return c % 2 !== 0 ? c - 1 : c;
}
