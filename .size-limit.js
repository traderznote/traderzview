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
];
