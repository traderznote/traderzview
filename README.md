# traderzview

A brand-new, **MIT-licensed**, open-source financial charting library — built from scratch in TypeScript.

traderzview is **original work**. It is not a fork. Its architecture was designed by deeply studying
the prior art in the space and then specifying a cleaner, smaller, faster library from first
principles. Everything here is our own — concepts, math, and code — free for anyone to use, for any
purpose, under the MIT license.

## Status

**v1.0.0 — feature-complete.** All v1 functionality is implemented, tested, and gated: the six series
types, time & price scales, multi-pane layouts, the crosshair, price lines, full pointer/touch
interaction, the four first-party plugins, drawing tools, indicators, multi-chart sync, and
screenshots. The library is renderer-agnostic with a Canvas 2D backend shipping in v1.

> Quality gates run on every change: strict TypeScript project-reference + dependency-cruiser import
> walls, per-module LOC budgets, brotli byte budgets per entry point, **1300+** unit tests, a headless
> end-to-end chart demo, profiling-symbols-are-free byte-identity, structural-invariant counters, and
> exact micro-benchmark goldens.

## Install

```sh
npm install traderzview
```

## Quickstart

```ts
import { createChart, CandlestickSeries } from 'traderzview';

const chart = createChart(document.getElementById('container')!, {
  layout: { textColor: '#191919' },
});

const candles = chart.addSeries(CandlestickSeries, { upColor: '#26a69a', downColor: '#ef5350' });
candles.setData([
  { time: '2026-01-05', open: 10, high: 14, low: 9,  close: 13 },
  { time: '2026-01-06', open: 13, high: 17, low: 12, close: 11 },
  { time: '2026-01-07', open: 11, high: 12, low: 8,  close: 9  },
]);

chart.subscribeCrosshairMove((param) => {
  const bar = param.seriesData.get(candles);
  // param.time, bar, param.paneIndex …
});

chart.timeScale().fitContent();
```

## Features (v1)

- **Six series types** — Line, Area, Baseline, Histogram, Bar, Candlestick.
- **Scales** — a horizontal time scale and price scales in normal / logarithmic / percentage /
  indexed-to-100 modes, multi-pane stacking, a grid, both left/right axes.
- **Crosshair** — normal / magnet / magnet-to-OHLC / hidden, with last-value and price-line axis labels.
- **Interaction** — pan, wheel zoom, kinetic fling, axis drag-scale, double-click reset, touch
  gestures, eased scroll/fit animations.
- **Screenshots** — `takeScreenshot()` / `toCanvas()` / `toBlob()`, with optional crosshair.
- **Plugins & extensibility** (`traderzview/extras`) — series & up/down markers, text & image
  watermarks, a drawing-tool host, an EMA indicator, and an N-chart sync group.
- **Renderer-agnostic** — views emit plain-data draw commands through a backend interface; a Canvas 2D
  backend ships in v1, and a GPU (WebGL/WebGPU) backend can be added later as a new backend only — no
  rewrite.

## Package entry points

traderzview ships three tree-shakable subpaths:

| Import | What it is |
| --- | --- |
| `traderzview` | The chart, series, scales, panes, crosshair, options, and events — the public API. |
| `traderzview/gfx` | The rendering seam — the draw-command vocabulary + `DisplayListBuilder`, for writing a custom backend or consuming the command stream. |
| `traderzview/extras` | Optional plugins: markers, watermarks, the drawing-tool host, the EMA indicator, multi-chart sync, and non-time-scale behaviors. Each is independently tree-shakable. |

## Architecture

Views convert model state into renderer-ready **draw commands** (a small, fixed vocabulary); a
**backend** replays those commands. The Canvas 2D backend is the v1 reference implementation. Strict
import walls between layers (`core → fmt → gfx / data → model → views / backend-canvas → host → api →
extras`) are enforced mechanically by TypeScript project references and dependency-cruiser, so the
seam between "what to draw" and "how to draw it" can never erode. Extension seams for drawing tools,
indicators, and multi-chart layouts are designed-in and proven in-tree, so app-level features arrive
as additions, not rework.

## License

[MIT](./LICENSE) — completely free to use, modify, and distribute.
