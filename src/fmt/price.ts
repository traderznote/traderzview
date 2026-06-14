// Price / percent / volume formatting (study 04 §4.9 — spec of record). The
// price formatter uses integer arithmetic (not toFixed) so tick snapping, the
// half-up carry, and the U+2212 minus sign match the reference exactly.

export interface IPriceFormatter {
  format(price: number): string;
}

/**
 * Decimal digits implied by a tick size, when the user gives `minMove` without
 * `precision` (study 09 §4.3). `0.25 → 2`, `0.001 → 3`; capped at 8, with a 1e-8
 * tolerance to absorb floating-point noise.
 */
export function precisionByMinMove(minMove: number): number {
  if (minMove >= 1) return 0;
  let i = 0;
  for (; i < 8; i++) {
    if (Math.abs(Math.round(minMove) - minMove) < 1e-8) return i;
    minMove *= 10;
  }
  return i;
}

function leftPadZeros(value: string, length: number): string {
  return value.length >= length ? value : '0'.repeat(length - value.length) + value;
}

class PriceFormatterImpl implements IPriceFormatter {
  readonly #p: number; // 10^precision
  readonly #m: number; // minMove * 10^precision  (falsy → 1)
  readonly #precision: number;

  constructor(precision: number, minMove: number) {
    this.#precision = precision;
    this.#p = 10 ** precision;
    const m = minMove * this.#p;
    this.#m = m > 0 && Number.isFinite(m) ? m : 1;
  }

  format(price: number): string {
    if (typeof price !== 'number' || !Number.isFinite(price)) return 'n/a';
    const sign = price < 0 ? '−' : '';
    const v = Math.abs(price);
    const base = this.#p / this.#m; // rounds to the nearest minMove
    let int = Math.floor(v);
    let fracStr: string;
    if (base > 1) {
      let frac = Math.round(v * base) - int * base;
      if (frac >= base) {
        frac -= base;
        int += 1;
      }
      fracStr = '.' + leftPadZeros(String(frac * this.#m), this.#precision);
    } else {
      int = Math.round(int * base) / base;
      fracStr = this.#precision > 0 ? '.' + '0'.repeat(this.#precision) : '';
    }
    return sign + int + fracStr;
  }
}

/** Decimal price formatter for `priceFormat.type === 'price'` (study 04 §4.9). */
export function priceFormatter(precision: number, minMove: number): IPriceFormatter {
  return new PriceFormatterImpl(precision, minMove);
}

/** Percent formatter — the price formatter plus a trailing `%` (study 04 §4.9). */
export function percentFormatter(precision: number, minMove: number): IPriceFormatter {
  const inner = new PriceFormatterImpl(precision, minMove);
  return {
    format(price: number): string {
      const s = inner.format(price);
      return s === 'n/a' ? s : s + '%';
    },
  };
}

// Two-stage volume stringify (study 04 §4.9) — NOT "toFixed + strip". Values ≥ 1
// take String() after rounding (float noise can surface); the trailing-zero strip
// then only removes zeros that follow digits 1-9 ("1.20"→"1.2", "1.1050" untouched).
function formatNumber(value: number, precision: number): string {
  const scale = 10 ** precision;
  const rounded = Math.round(value * scale) / scale;
  let s: string;
  if (rounded >= 1e-15 && rounded < 1) {
    s = rounded.toFixed(precision).replace(/\.?0+$/, '');
  } else {
    s = String(rounded);
  }
  return s.replace(/(\.[1-9]*)0+$/, '$1');
}

/** Volume formatter for `priceFormat.type === 'volume'` — K/M/B (study 04 §4.9). */
export function volumeFormatter(precision: number): IPriceFormatter {
  return {
    format(value: number): string {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
      const sign = value < 0 ? '-' : ''; // ASCII '-', unlike PriceFormatter's U+2212
      let av = Math.abs(value);
      let body: string;
      if (av < 995) {
        body = formatNumber(av, precision);
      } else if (av < 999995) {
        body = formatNumber(av / 1000, precision) + 'K';
      } else if (av < 999999995) {
        av = 1000 * Math.round(av / 1000);
        body = formatNumber(av / 1e6, precision) + 'M';
      } else {
        av = 1e6 * Math.round(av / 1e6);
        body = formatNumber(av / 1e9, precision) + 'B';
      }
      return sign + body;
    },
  };
}
