// bench/data-gen.mjs — the seeded deterministic series generator (perf §9.1). Every
// bench run sees IDENTICAL bytes: one mulberry32 PRNG (seed 0x7eadbeef, the M4 demo
// seed) drives a realistic random walk, so scene fixtures, baselines, and the §4.4
// structural-count gates are reproducible. NO browser, NO library import — plain data
// the scene builders feed to setData(). Time is an integer index (the simplest Time the
// default timeBehavior accepts; §4.1 fixes the geometry, not the calendar).
//
// Exports: mulberry32, lineSeries(n), candleSeries(n), histogramSeries(n) — each a fresh
// generator from the canonical seed unless a seed override is passed (S17 smoke wants a
// few distinct-but-deterministic series). The walks are bounded so autoscale ranges are
// finite and the per-point memory gates (§6.2) measure steady lanes.

/** The canonical seed — the M4 demo seed (perf §4.1). All gated scenes use it. */
export const SEED = 0x7eadbeef;

/**
 * mulberry32 — a fast, well-distributed 32-bit PRNG (perf §4.1). Returns a function
 * yielding floats in [0, 1). Identical output for identical seed across every platform
 * (pure uint32 math), which is the whole point: the bench is byte-deterministic.
 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// A bounded random walk: each step nudges the value by a small signed delta, with a weak
// mean-reversion pull toward `base` so an N=1e6 walk never drifts to ±Infinity (keeps
// autoscale ranges finite and the §6.2 memory lanes representative).
function* walk(rng, base, step) {
  let v = base;
  for (;;) {
    const drift = (rng() - 0.5) * step;
    const revert = (base - v) * 0.001;
    v += drift + revert;
    yield v;
  }
}

/** N line points `{ time, value }` — one f64 value lane (the §6.2 line-budget shape). */
export function lineSeries(n, seed = SEED) {
  const w = walk(mulberry32(seed), 100, 2);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { time: i, value: w.next().value };
  return out;
}

/** N candlestick points `{ time, open, high, low, close }` — the 4-lane §6.2 candle
 *  shape. open = previous close (a continuous bar series); high/low bracket o/c by a
 *  seeded wick so the body is always inside [low, high]. */
export function candleSeries(n, seed = SEED) {
  const rng = mulberry32(seed);
  const w = walk(rng, 100, 2);
  const out = new Array(n);
  let open = w.next().value;
  for (let i = 0; i < n; i++) {
    const close = w.next().value;
    const hi = Math.max(open, close) + rng() * 1.5;
    const lo = Math.min(open, close) - rng() * 1.5;
    out[i] = { time: i, open, high: hi, low: lo, close };
    open = close;
  }
  return out;
}

/** N histogram points `{ time, value }` — non-negative magnitudes (a volume-like lane). */
export function histogramSeries(n, seed = SEED) {
  const w = walk(mulberry32(seed), 50, 4);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { time: i, value: Math.abs(w.next().value) };
  return out;
}
