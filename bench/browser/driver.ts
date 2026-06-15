// bench/browser/driver.ts — the browser-side bench driver (perf §9.1). Bundled to an IIFE
// by run.mjs (__TV_PROFILE__=true) and evaluated in a throttled Playwright Chromium page.
// It builds a REAL canvasBackend() chart per scene (real bitmaps, real frame loop), wires an
// IPerfSink that records every FrameStats, and adapts the scene fixture to the abstract
// BenchChart the scenario scripts (scenarios.ts) drive. Exposed on window for the runner:
//   window.__tvBench = {
//     scenarios(): string[];               // the catalog ids
//     probeLabels(id): string[];           // the probe() labels a scenario declares (order)
//     run(id, runIndex): FrameStats[];     // build the scene, run the script, return frames
//   }
// The runner brackets each probe() with a CDP HeapProfiler snapshot (perf §5.3/§6.2); the
// driver records the label ORDER a run hit so the runner knows how many snapshots to take.
//
// This file runs ONLY in the CI browser job (the node gates never import it). It is written
// against the real API so it stays honest, but it is not exercised by the M10 node gates.
import { createChart, LineSeries, AreaSeries, CandlestickSeries, HistogramSeries }
  from '../../src/api/index';
import type { IChart, ISeries, SeriesType } from '../../src/api/index';
import type { Time } from '../../src/data/index';
import type { FrameStats, IPerfSink } from '../../src/host/profiling';
import { lineSeries, candleSeries, histogramSeries } from '../data-gen.mjs';
import { SCENARIOS } from '../scenarios';
import type { BenchChart, BenchHarness, SceneId } from '../gates';

declare global {
  interface Window {
    // The bench sink injection the harness reads (perf §9.6); set per-run before building.
    __tvFrames: FrameStats[];
    __tvBench: {
      scenarios(): string[];
      probeLabels(id: string): string[];
      run(id: string, runIndex: number): Promise<FrameStats[]>;
    };
  }
}

const SIZE = { width: 1600, height: 900 };

// Build one real chart for a scene and return the BenchChart adapter + the series handles.
// createChart wires the canvas backend; a perfSink/frameCounters env is threaded through the
// public createChart by the harness (the bench build keeps the __TV_PROFILE__ fields).
function buildScene(scene: SceneId): { chart: IChart<Time>; series: ISeries<SeriesType, Time>[]; container: HTMLElement } {
  const container = document.createElement('div');
  container.style.cssText = `position:relative;width:${SIZE.width}px;height:${SIZE.height}px`;
  document.body.appendChild(container);
  const chart = createChart(container, { width: SIZE.width, height: SIZE.height });
  const series: ISeries<SeriesType, Time>[] = [];
  const add = (def: Parameters<IChart<Time>['addSeries']>[0], data: readonly unknown[], pane: number): void => {
    const h = chart.addSeries(def, {}, pane);
    h.setData(data as never);
    series.push(h);
  };
  const P = scenePoints(scene);
  switch (scene) {
    case 'R0': break;
    case 'R1':
    case 'R6':
      add(CandlestickSeries, candleSeries(P, 0xc0), 0);
      add(LineSeries, lineSeries(P, 0x11), 0);
      add(LineSeries, lineSeries(P, 0x12), 0);
      add(AreaSeries, lineSeries(P, 0xa1), 0);
      add(HistogramSeries, histogramSeries(P, 0x40), 1);
      break;
    case 'R2':
      add(LineSeries, lineSeries(P, 0x21), 0);
      add(CandlestickSeries, candleSeries(P, 0x22), 0);
      chart.timeScale().fitContent();
      break;
    case 'R3':
      for (let i = 0; i < 50; i++) add(LineSeries, lineSeries(10_000, 0x300 + i), 0);
      break;
    case 'R4':
      add(CandlestickSeries, candleSeries(P, 0x401), 0);
      add(LineSeries, lineSeries(P, 0x402), 0);
      add(HistogramSeries, histogramSeries(P, 0x403), 1);
      add(LineSeries, lineSeries(P, 0x404), 2);
      add(AreaSeries, lineSeries(P, 0x405), 3);
      break;
    case 'R5':
      for (let i = 0; i < 20; i++) add(LineSeries, lineSeries(10_000, 0x500 + i), 0);
      break;
    case 'smoke':
      add(LineSeries, lineSeries(5_000_000, 0x701), 0);
      break;
  }
  if (scene === 'R6') {
    for (let i = 0; i < 100; i++) series[0].createPriceLine({ price: 80 + i * 0.4 });
  }
  return { chart, series, container };
}

function scenePoints(scene: SceneId): number {
  if (scene === 'R2') return 1_000_000;
  if (scene === 'smoke') return 5_000_000;
  return 100_000; // R1/R4/R6
}

// Await the next painted frame: the perfSink pushes a FrameStats; resolve when frames grow.
function nextPaint(frames: FrameStats[]): Promise<void> {
  const before = frames.length;
  return new Promise((resolve) => {
    const tick = (): void => { if (frames.length > before) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

// Adapt the real chart to the abstract BenchChart the scripts drive (perf §9.6).
function adapt(built: ReturnType<typeof buildScene>, frames: FrameStats[]): BenchChart {
  const { chart, series } = built;
  const dispatch = (type: string, x: number, y: number, extra?: Record<string, number>): void => {
    const el = chart.element();
    el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, ...extra }));
  };
  return {
    setData: (i, data) => series[i]?.setData(data as never),
    update: (i, point) => series[i]?.update(point as never),
    async crosshairMove(x, y) { dispatch('mousemove', x, y); await nextPaint(frames); },
    async wheel(x, y, deltaY) {
      chart.element().dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY, bubbles: true }));
      await nextPaint(frames);
    },
    async pan(dxBars) {
      const ts = chart.timeScale();
      ts.scrollToPosition(ts.scrollPosition() - dxBars, false);
      await nextPaint(frames);
    },
    frame: () => nextPaint(frames),
  };
}

window.__tvBench = {
  scenarios: () => SCENARIOS.map((s) => s.id),
  probeLabels(id) {
    // Re-run the script with a recording harness over a no-op chart to capture the probe
    // label order WITHOUT building a real scene (probe order is data-dependent only on the
    // script, not the scene). The runner takes one CDP snapshot per label in this order.
    const spec = SCENARIOS.find((s) => s.id === id);
    if (!spec) return [];
    const labels: string[] = [];
    const harness: BenchHarness = { probe: async (l) => void labels.push(l) };
    const noop = new Proxy({}, { get: () => async () => {} }) as unknown as BenchChart;
    // Best-effort synchronous label capture: the scripts call probe() between cheap setData
    // calls, so awaiting a microtask-only chart resolves them in order.
    void spec.script(noop, harness);
    return labels;
  },
  async run(id) {
    const spec = SCENARIOS.find((s) => s.id === id);
    if (!spec) throw new Error(`unknown scenario ${id}`);
    const frames: FrameStats[] = [];
    window.__tvFrames = frames;
    const sink: IPerfSink = { onFrame: (s) => frames.push(s) };
    // The perfSink reaches the chart through the bench-build createChart (the harness sets
    // a global the __TV_PROFILE__ create-chart path reads). Kept on window so the IIFE and
    // the page share it; in the shipped build this whole field is stripped (perf §3.3.1).
    (window as unknown as { __tvSink?: IPerfSink }).__tvSink = sink;
    const built = buildScene(spec.scene);
    const chart = adapt(built, frames);
    const harness: BenchHarness = { probe: async () => { await nextPaint(frames).catch(() => {}); } };
    await spec.script(chart, harness);
    built.chart.dispose();
    built.container.remove();
    return frames;
  },
};
