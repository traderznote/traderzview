// Price-scale modes + their transform math (study 04 §4.2 percent/indexed,
// §4.3 log + adaptive formula are the spec of record). The price range is stored
// in LOGICAL space (architecture §4.6 / study 04 §2): logical == price in Normal
// mode, and == the active transform of price in Log / Percentage / Indexed modes.
//
// Two architecture-flagged points:
//   • Indexed-to-100 is FIXED to be a TRUE inverse pair for negative base
//     (architecture §13.10): the percent part is negated BEFORE adding 100, so
//     `fromIndexed(toIndexed(v,b),b) === v` for either sign — unlike the reference,
//     which round-tripped negative-base values to `v + 2b`.
//   • The mode is a const-object union, not an `enum` (erasableSyntaxOnly, M0).

/** The four scale modes (architecture §4.6). Const-object union, not an enum. */
export const PriceScaleMode = {
  Normal: 0,
  Logarithmic: 1,
  Percentage: 2,
  IndexedTo100: 3,
} as const;
export type PriceScaleMode = (typeof PriceScaleMode)[keyof typeof PriceScaleMode];

/** A pair `{logicalOffset L, coordOffset C}` parameterizing the log transform. */
export interface LogFormula {
  /** L — added to log10 so typical prices map to positive logicals. */
  readonly logicalOffset: number;
  /** C — keeps prices near 0 finite (avoids log10(0)). */
  readonly coordOffset: number;
}

/** A min/max pair in either raw or logical space — ranges are NOT re-sorted by
 *  the transforms (study 04 §4.2: negative-base transforms can invert ordering). */
export interface MinMax {
  readonly min: number;
  readonly max: number;
}

// --- mode flags read by navigator.ts / autoscale.ts (study 04 §3.4) -------------

/** Percentage / Indexed-to-100 refuse every manual-scale entry point — they have
 *  no meaningful absolute range to drag (study 04 §3.4; read by navigator.ts). */
export function refusesManualScale(mode: PriceScaleMode): boolean {
  return mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100;
}

/** Entering Percentage / Indexed-to-100 forces autoScale ← true (study 04 §3.5). */
export function isAutoScaleForced(mode: PriceScaleMode): boolean {
  return mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100;
}

// --- percentage (study 04 §4.2) -------------------------------------------------
// toPercent(v,b)   = b<0 ? −r : r,   r = 100·(v − b)/b
// fromPercent(p,b) = (p'/100)·b + b, p' = b<0 ? −p : p     (true inverse, both signs)

/** Raw price → percentage logical (study 04 §4.2). */
export function toPercent(value: number, baseValue: number): number {
  const r = (100 * (value - baseValue)) / baseValue;
  return baseValue < 0 ? -r : r;
}

/** Percentage logical → raw price (study 04 §4.2). True inverse for either sign. */
export function fromPercent(percent: number, baseValue: number): number {
  const p = baseValue < 0 ? -percent : percent;
  return (p / 100) * baseValue + baseValue;
}

// --- indexed-to-100 (study 04 §4.2 + architecture §13.10 FIX) -------------------
// The FIX: index = percent + 100 (negate the percent part BEFORE adding 100), so
// the pair is a true inverse for negative base too.
//   toIndexed(v,b)   = toPercent(v,b) + 100
//   fromIndexed(x,b) = fromPercent(x − 100, b)

/** Raw price → indexed-to-100 logical (architecture §13.10 FIXED). */
export function toIndexed(value: number, baseValue: number): number {
  return toPercent(value, baseValue) + 100;
}

/** Indexed-to-100 logical → raw price (architecture §13.10 FIXED — true inverse). */
export function fromIndexed(indexed: number, baseValue: number): number {
  return fromPercent(indexed - 100, baseValue);
}

// --- logarithmic (study 04 §4.3) ------------------------------------------------
// toLog(p)   = 0                              if |p| < 1e−15
//            = sign(p)·(log10(|p| + C) + L)   otherwise
// fromLog(x) = 0                              if |x| < 1e−15
//            = sign(x)·(10^(|x| − L) − C)     otherwise

const LOG_ZERO_EPS = 1e-15;

/** The default log formula {L=4, C=1e−4} (study 04 §4.3). */
export function defaultLogFormula(): LogFormula {
  return { logicalOffset: 4, coordOffset: 0.0001 };
}

/** Raw price → log logical. Symmetric around 0; handles negative prices. */
export function toLog(price: number, formula: LogFormula = defaultLogFormula()): number {
  if (Math.abs(price) < LOG_ZERO_EPS) return 0;
  const abs = Math.abs(price);
  const value = Math.log10(abs + formula.coordOffset) + formula.logicalOffset;
  return price < 0 ? -value : value;
}

/** Log logical → raw price. Inverse of `toLog` under the same formula. */
export function fromLog(logical: number, formula: LogFormula = defaultLogFormula()): number {
  if (Math.abs(logical) < LOG_ZERO_EPS) return 0;
  const abs = Math.abs(logical);
  const value = 10 ** (abs - formula.logicalOffset) - formula.coordOffset;
  return logical < 0 ? -value : value;
}

/** Apply `toLog` to both bounds (study 04 §4.2: ranges are not re-sorted). */
export function toLogRange(range: MinMax, formula: LogFormula = defaultLogFormula()): MinMax {
  return { min: toLog(range.min, formula), max: toLog(range.max, formula) };
}

/** Apply `fromLog` to both bounds. */
export function fromLogRange(range: MinMax, formula: LogFormula = defaultLogFormula()): MinMax {
  return { min: fromLog(range.min, formula), max: fromLog(range.max, formula) };
}

/**
 * Adaptive log formula for tiny raw ranges (study 04 §4.3). The fixed C=1e−4
 * flattens sub-1 ranges, so re-derive {L,C} from the range width:
 *   d ≥ 1 or d < 1e−15 → default;  else L = 4 + ceil(|log10(d)|), C = 10^(−L).
 */
export function logFormulaForRange(rawRange: MinMax | null): LogFormula {
  if (rawRange === null) return defaultLogFormula();
  const d = Math.abs(rawRange.max - rawRange.min);
  if (d >= 1 || d < LOG_ZERO_EPS) return defaultLogFormula();
  const digits = Math.ceil(Math.abs(Math.log10(d)));
  const logicalOffset = 4 + digits;
  return { logicalOffset, coordOffset: 10 ** -logicalOffset };
}

/** Converting a log range back to raw is only possible when both bounds come out
 *  finite (study 04 §4.3); otherwise mode-switching falls back to autoscale. */
export function canConvertFromLog(logRange: MinMax, formula: LogFormula = defaultLogFormula()): boolean {
  const raw = fromLogRange(logRange, formula);
  return Number.isFinite(raw.min) && Number.isFinite(raw.max);
}
