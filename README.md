# traderzview

A brand-new, **MIT-licensed**, open-source financial charting library — built from scratch in TypeScript.

traderzview is **original work**. It is not a fork. Its architecture was designed by deeply studying
the prior art in the space and then specifying a cleaner, smaller, faster library from first
principles. Everything here is our own — concepts, math, and code — free for anyone to use, for any
purpose, under the MIT license.

## Status

**Pre-implementation.** The complete design is finished and verified; no library code is written yet.
The entire build plan lives in [`dev-docs/`](./dev-docs/) and is detailed enough to implement the
library without any external reference.

## Goals

- **Feature parity** with today's best lightweight charting libraries in v1 (all common series types,
  time & price scales, panes, plugins/primitives, full mouse/touch interaction).
- **Renderer-agnostic core.** Views emit draw commands through a backend interface. A Canvas 2D
  backend ships in v1; a GPU (WebGL/WebGPU) backend can be added later as a new backend only — no
  rewrite.
- **Cleaner, smaller, faster** — better architecture, fewer lines of code, and explicit performance
  budgets.
- **Designed-in extension seams** for drawing tools, indicators, and multi-chart layouts, so
  TradingView-app-level features arrive later as additions, not rework.

## Documentation

Start at **[`dev-docs/00-overview.md`](./dev-docs/00-overview.md)** — the front door, with the full
reading order.

```text
dev-docs/
├── 00-overview.md     — mission, locked decisions, reading order, ground rules
├── design-spec.md     — the founding Phase 0 design spec
├── study/             — how the prior art works (10 verified reference docs)
└── design/            — what traderzview is (6 design docs)
    ├── 01-architecture.md            — binding architecture (read first)
    ├── 02-public-api-spec.md
    ├── 03-rendering-backend-spec.md
    ├── 04-performance-strategy.md
    ├── 05-extensibility-roadmap.md
    └── 06-implementation-roadmap.md  — milestone-by-milestone build order (start building here)
```

**Ground rules:** the `study/` docs are *facts* (how the prior art behaves), the `design/` docs are
*decisions* (what we build), and `design/06-implementation-roadmap.md` is *orders* (the build
sequence). No source code from any studied library appears in these docs — concepts, math, and
original interface sketches only.

## Building it

Implementation begins at **milestone 0 (repo bootstrap)** in
[`dev-docs/design/06-implementation-roadmap.md`](./dev-docs/design/06-implementation-roadmap.md),
which specifies the tooling, build, test harness, and performance gates, then proceeds milestone by
milestone to a v1 release.

## License

[MIT](./LICENSE) — completely free to use, modify, and distribute.
