// Bundle-size budgets (brotli) — the hard contract from
// dev-docs/design/04-performance-strategy.md §3.1. Measured by @size-limit/file on
// the published build (scripts/build.mjs, __DEV__=false). Editing any number here
// requires a rationale line in the same PR (perf §3.3.3).
//
// FULL CONTRACT (committed now; each row activates as its entry is built):
//   E1  import * (root: factories + 6 series)          <= 38.0 KB   (ref 52.0)
//   E2  { createChart } only                            <= 33.0 KB   (ref 45.0)
//   E3  { createChartWith } (headless, tree-shaken)     <= 28.0 KB
//   E4  standalone IIFE (createChart + 6 series)         <= 42.0 KB   (ref 53.5)
//   E5  traderzview/gfx subpath                          <=  4.0 KB
//   E1 + all extras (split-honesty gate)                <= 45.0 KB
//   per-series increments over E2 (KB): Line 2.0  Area 2.5  Baseline 2.5  Bar 1.5  Candlestick 2.0  Histogram 2.0
//   extras increments over E2 (KB):    seriesMarkers 3.0  upDownMarkers 2.0  textWatermark 1.5  imageWatermark 1.5
//                                       ToolHost 3.0  SyncGroup 1.0  emaIndicator 1.0  priceAxis/yieldCurve 1.5 each
//
// Active rows (entries that exist at the current milestone):
export default [
  {
    name: "E1 — import * from 'traderzview' (root)",
    path: 'dist/index.mjs',
    limit: '38 KB',
    brotli: true,
  },
  {
    name: 'E5 — traderzview/gfx subpath',
    path: 'dist/gfx.mjs',
    limit: '4 KB',
    brotli: true,
  },
  // The four first-party plugins (M12), each as its own bundle so the per-plugin caps
  // measure the plugin's marginal cost in isolation (the "extras increments" row above).
  {
    name: 'extras/series-markers',
    path: 'dist/extras/series-markers.mjs',
    limit: '3 KB',
    brotli: true,
  },
  {
    name: 'extras/up-down-markers',
    path: 'dist/extras/up-down-markers.mjs',
    limit: '2 KB',
    brotli: true,
  },
  {
    name: 'extras/text-watermark',
    path: 'dist/extras/text-watermark.mjs',
    limit: '1.5 KB',
    brotli: true,
  },
  {
    name: 'extras/image-watermark',
    path: 'dist/extras/image-watermark.mjs',
    limit: '1.5 KB',
    brotli: true,
  },
  // The M13 extensibility-seam proofs (design 05 §4–§7), each its own marginal-cost
  // bundle so the per-seam caps measure the seam's own code in isolation (the
  // "extras increments over E2" row above: ToolHost 3.0 / SyncGroup 1.0 / emaIndicator
  // 1.0 / priceAxis,yieldCurve 1.5 each).
  {
    name: 'extras/tool-host',
    path: 'dist/extras/tool-host.mjs',
    limit: '3 KB',
    brotli: true,
  },
  {
    name: 'extras/sync-group',
    path: 'dist/extras/sync-group.mjs',
    limit: '1 KB',
    brotli: true,
  },
  {
    name: 'extras/ema',
    path: 'dist/extras/ema.mjs',
    limit: '1 KB',
    brotli: true,
  },
  {
    name: 'extras/price-axis',
    path: 'dist/extras/price-axis.mjs',
    limit: '1.5 KB',
    brotli: true,
  },
  {
    name: 'extras/yield-curve',
    path: 'dist/extras/yield-curve.mjs',
    limit: '1.5 KB',
    brotli: true,
  },
];
