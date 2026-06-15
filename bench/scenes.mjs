// bench/scenes.mjs — builders for the reference scenes R0-R6 (perf §4.1). Each builder
// constructs a chart fixture: it makes a headless BenchChart (harness.mjs), adds the
// scene's panes + series, feeds each series its seeded data (data-gen.mjs), and returns
// { ...benchChart, scene, series } so a ScenarioSpec.script can drive interactions and
// read frameCounters/FrameStats for the §4.4 structural gates.
//
// These build the NODE-runnable fixtures over the stub backend (the structural/memory
// gates that run now). The Playwright runner (run.mjs) builds the SAME scene shapes over
// a REAL canvasBackend() in a browser page for the frame-time gates (CI-gated) — the
// scene catalog is shared; only the backend + driver differ.
//
// §4.1 scenes (all DPR 2, the runner sets deviceScaleFactor; the stub backend reports
// hr=1 but the geometry/counts the structural gates read are DPR-independent):
//   R0  empty chart, 1600×900
//   R1  "parity"  2 panes; pane0: candle + 2 line + area, pane1: histogram; 100k pts; 1000 visible
//   R2  "bulk"    1 line + 1 candle, 1M pts, fitContent (sub-pixel → §6.3 decimation)
//   R3  "breadth" 50 line × 10k, one pane, 2000 visible
//   R4  "depth"   4 panes (candle+line / histogram / line / area), 100k pts, 1000 visible
//   R5  "fanout"  20 line × 10k, one pane, 1000 visible
//   R6  "extras"  R1 + 100 price lines on the candle + 10k markers (2000/series)
import { makeBenchChart, seriesDefs } from './harness.mjs';
import { lineSeries, candleSeries, histogramSeries } from './data-gen.mjs';

const R = { width: 1600, height: 900 };

// AREA SUBSTITUTION (node path only). Driving an AreaSeries through createChartWith
// currently throws inside composite (a pre-existing M9 wiring bug — areaKindFactory drops
// the kind's ItemBuffer, so itemsFromStore hits a stub buffer with no ensure(); fix tracked
// separately, M11 parity). The node-runnable STRUCTURAL gates read counts off a working
// scene, and area is line-like (one single-value lane, the same O(runs) draw-command
// profile), so the node scene builders render the §4.1 area slot with a LineSeries — the
// source topology and the §4.4 counts are faithful. The browser runner (run.mjs, CI-gated,
// runs post-fix) builds the REAL AreaSeries. `areaDef(d)` selects the substitute.
function areaDef(d) { return d.LineSeries; } // node stub: line stands in for area (see above)

// Set the visible window to `bars` (the last `bars` of the data) via the time scale's
// logical range. A miss (headless time-scale stub returns null geometry) is non-fatal —
// the structural counts the node gates read do not depend on the exact pixel window; the
// browser runner sets the real window. Recorded on the scene for the runner to honor.
function setVisible(chart, total, bars) {
  try { chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - bars), to: total - 1 }); }
  catch { /* headless stub: window is advisory; runner applies it for real */ }
}

/** R0 — empty chart, no series. The cold-init / first-paint scene (S1). */
export async function R0() {
  const f = await makeBenchChart({ mediaSize: R });
  return { ...f, scene: { id: 'R0', visibleBars: 0, series: [] } };
}

/** R1 "parity" — 2 panes; pane0: candle + 2 line + area, pane1: histogram; 100k pts each. */
export async function R1(points = 100_000, visible = 1000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [];
  // pane 0 (index 0): 1 candlestick + 2 line + 1 area
  series.push(addData(f.chart.addSeries(d.CandlestickSeries, {}, 0), candleSeries(points, 0xc0)));
  series.push(addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x11)));
  series.push(addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x12)));
  series.push(addData(f.chart.addSeries(areaDef(d), {}, 0), lineSeries(points, 0xa1)));
  // pane 1 (index 1, freshly created): 1 histogram
  series.push(addData(f.chart.addSeries(d.HistogramSeries, {}, 1), histogramSeries(points, 0x40)));
  f.raf.flush(1);
  setVisible(f.chart, points, visible);
  f.raf.flush(2);
  return { ...f, scene: { id: 'R1', visibleBars: visible, points, series: ['candle', 'line', 'line', 'area', 'histogram'] }, series };
}

/** R2 "bulk" — 1 line + 1 candle, 1M pts, fitContent (sub-pixel spacing → §6.3 decimation). */
export async function R2(points = 1_000_000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [
    addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x21)),
    addData(f.chart.addSeries(d.CandlestickSeries, {}, 0), candleSeries(points, 0x22)),
  ];
  f.chart.timeScale().fitContent(); // 1M pts over 1600px → barSpacing·hr < 1 → decimation active
  f.raf.flush(1);
  return { ...f, scene: { id: 'R2', visibleBars: points, points, decimated: true, series: ['line', 'candle'] }, series };
}

/** R3 "breadth" — 50 line series × 10k points, one pane, visible 2000 bars. */
export async function R3(count = 50, points = 10_000, visible = 2000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [];
  for (let i = 0; i < count; i++) series.push(addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x300 + i)));
  f.raf.flush(1);
  setVisible(f.chart, points, visible);
  f.raf.flush(2);
  return { ...f, scene: { id: 'R3', visibleBars: visible, points, seriesCount: count }, series };
}

/** R4 "depth" — 4 panes (candle+line / histogram / line / area), 100k pts, visible 1000. */
export async function R4(points = 100_000, visible = 1000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [
    addData(f.chart.addSeries(d.CandlestickSeries, {}, 0), candleSeries(points, 0x401)),
    addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x402)),
    addData(f.chart.addSeries(d.HistogramSeries, {}, 1), histogramSeries(points, 0x403)),
    addData(f.chart.addSeries(d.LineSeries, {}, 2), lineSeries(points, 0x404)),
    addData(f.chart.addSeries(areaDef(d), {}, 3), lineSeries(points, 0x405)),
  ];
  f.raf.flush(1);
  setVisible(f.chart, points, visible);
  f.raf.flush(2);
  return { ...f, scene: { id: 'R4', visibleBars: visible, points, panes: 4 }, series };
}

/** R5 "fanout" — 20 line series × 10k points, one pane, visible 1000 bars. */
export async function R5(count = 20, points = 10_000, visible = 1000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [];
  for (let i = 0; i < count; i++) series.push(addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x500 + i)));
  f.raf.flush(1);
  setVisible(f.chart, points, visible);
  f.raf.flush(2);
  return { ...f, scene: { id: 'R5', visibleBars: visible, points, seriesCount: count }, series };
}

/** R6 "extras" — R1 + 100 price lines on the candle series + 10k markers (2000/series). */
export async function R6(points = 100_000, visible = 1000) {
  const base = await R1(points, visible);
  const candle = base.series[0]; // pane0's candlestick handle
  const priceLines = [];
  for (let i = 0; i < 100; i++) priceLines.push(candle.createPriceLine({ price: 80 + i * 0.4, color: '#888' }));
  // 10k markers, 2000 per series across the 5 series, evenly spread (~20 land in a 1000-bar
  // window). setMarkers is the §13 extras seam; absent on a bare handle → recorded on the
  // scene for the runner to apply (the markers' draw-command bound is what S16 gates).
  const markers = [];
  for (let s = 0; s < base.series.length; s++) {
    const step = Math.max(1, Math.floor(points / 2000));
    const m = [];
    for (let i = 0; i < 2000; i++) m.push({ time: i * step, position: 'aboveBar', shape: 'circle' });
    const h = base.series[s];
    if (typeof h.setMarkers === 'function') h.setMarkers(m);
    markers.push({ series: s, count: m.length });
  }
  base.raf.flush(3);
  return { ...base, scene: { id: 'R6', visibleBars: visible, points, priceLines: priceLines.length, markers: 10_000 }, priceLines };
}

// Feed a series its seeded data and return the handle (so callers can chain).
function addData(handle, data) {
  handle.setData(data);
  return handle;
}

/** The scene registry the runner + node gates index by id (perf §9.2). */
export const SCENES = { R0, R1, R2, R3, R4, R5, R6 };
