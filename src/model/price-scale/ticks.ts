// The PriceTickEngine (study 04 §4.5 tick-span selection + §4.6 mark building are
// the spec of record). Produces "readable" price steps (10^n × {1,2,2.5,5}) such
// that adjacent marks are at least `tickMarkHeight` px apart, then walks the
// visible logical range emitting marks (with log-crowding + clip guards).
import type { PriceGeometry } from './geometry';
import { PriceScaleMode } from './modes';

const EPS = 1e-14;

// greaterOrEqual(a, b) ≡ b − a ≤ ε  (study 04 §4.5; the explicit strict clause at
// call sites guards values like 1e−10 where this helper alone misbehaves).
function geq(a: number, b: number): boolean {
  return b - a <= EPS;
}

function isPowerOfTen(n: number): boolean {
  if (n <= 0) return false;
  let x = n;
  while (x > 1 && x % 10 === 0) x /= 10;
  return x === 1;
}

/** Fractional divider cycle for a base (study 04 §4.5). */
function fractionalDividers(base: number): number[] {
  if (base <= 0) return [];
  if (base > 1e18 || isPowerOfTen(base)) return [2, 2.5, 2];
  const dividers: number[] = [];
  let b = base;
  let guard = 0;
  while (b > 1) {
    if (guard++ > 100) throw new Error('tickSpan: base divider overflow');
    if (b % 2 === 0) {
      dividers.push(2);
      b /= 2;
    } else if (b % 5 === 0) {
      dividers.push(2, 2.5);
      b /= 5;
    } else {
      throw new Error('tickSpan: base has a non-2/5 prime factor');
    }
  }
  return dividers;
}

function tickSpanOne(high: number, low: number, maxTickSpan: number, base: number, cycle: readonly number[]): number {
  const minMovement = base === 0 ? 0 : 1 / base;
  let span = 10 ** Math.max(0, Math.ceil(Math.log10(high - low)));
  let ci = 0;
  for (;;) {
    const c = cycle[ci % cycle.length];
    const ok =
      geq(span, minMovement) &&
      span > minMovement + EPS &&
      geq(span, maxTickSpan * c) &&
      geq(span, 1);
    if (!ok) break;
    span /= c;
    ci++;
  }
  if (span <= minMovement + EPS) span = minMovement;
  span = Math.max(1, span);
  const frac = fractionalDividers(base);
  if (frac.length > 0 && Math.abs(span - 1) < EPS) {
    let fi = 0;
    while (geq(span, maxTickSpan * frac[fi % frac.length]) && span > minMovement + EPS) {
      span /= frac[fi % frac.length];
      fi++;
    }
  }
  return span;
}

/**
 * The readable logical step for the visible `[low, high]` range — the minimum of
 * the three integral divider cycles (study 04 §4.5). `base` = round(1/minMove).
 */
export function tickSpan(high: number, low: number, height: number, base: number, fontSize = 12, density = 2.5): number {
  const tickMarkHeight = Math.ceil(fontSize * density);
  const maxTickSpan = ((high - low) * tickMarkHeight) / height;
  let best = Infinity;
  for (const cycle of [
    [2, 2.5, 2],
    [2, 2, 2.5],
    [2.5, 2, 2],
  ]) {
    const s = tickSpanOne(high, low, maxTickSpan, base, cycle);
    if (s < best) best = s;
  }
  return best;
}

export interface PriceTick {
  readonly coord: number;
  readonly logical: number;
}

/** Build the visible tick marks for a geometry (study 04 §4.6). */
export function rebuildTickMarks(
  geom: PriceGeometry,
  base: number,
  opts?: { fontSize?: number; density?: number; entireTextOnly?: boolean },
): PriceTick[] {
  if (geom.isEmpty) return [];
  const H = geom.height;
  const fontSize = opts?.fontSize ?? 12;
  const density = opts?.density ?? 2.5;
  const tickMarkHeight = Math.ceil(fontSize * density);

  const top = geom.coordinateToLogical(0);
  const bottom = geom.coordinateToLogical(H - 1);
  const high = Math.max(top, bottom);
  const low = Math.min(top, bottom);
  if (high === low) return [];

  const pad = opts?.entireTextOnly ? fontSize / 2 : 0;
  const minCoord = pad;
  const maxCoord = H - 1 - pad;
  const isLog = geom.mode === PriceScaleMode.Logarithmic;

  let span = tickSpan(high, low, H, base, fontSize, density);
  let mod = high % span;
  if (mod < 0) mod += span;

  const out: PriceTick[] = [];
  let prevCoord: number | null = null;
  for (let logical = high - mod; logical > low; logical -= span) {
    const coord = geom.logicalToCoordinate(logical);
    if (prevCoord !== null && Math.abs(coord - prevCoord) < tickMarkHeight) continue; // crowding
    if (coord < minCoord || coord > maxCoord) continue; // clipped
    out.push({ coord, logical });
    prevCoord = coord;
    if (isLog) span = tickSpan(logical, low, H, base, fontSize, density); // step shrinks downward
  }
  return out;
}
