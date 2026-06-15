// bench/gates.ts — the typed regression-gate model (perf §9.6): MetricSource / MetricGate
// / ScenarioSpec + the probe bridge. A gate is a typed record a scenario DECLARES (a
// metric, a cap, a comparison); the runner produces samples on the metric's `source`
// channel and asserts the aggregated value against `cap` (hard) and the committed baseline
// drift (§9.5). This file is the contract; run.mjs is the engine that evaluates it.
//
// `FrameStats` is imported from the host (the per-frame snapshot the IPerfSink stream
// delivers) so a 'frame' gate's `metric` is type-checked to be a real FrameStats lane.
// bench/ is a workspace package outside the §3.1 import wall — like bench/conformance it
// reaches into ../../src directly (it is never shipped, perf §9.1).
import type { FrameStats } from '../src/host/profiling';

// Two metric SOURCES, because two kinds of number exist (the §5.3/§6.2 bridge):
//   'frame'  — one value per FrameStats the IPerfSink.onFrame stream delivers (every
//              keyof-FrameStats metric); aggregated over the scenario's frames.
//   'probe'  — one value per HEAP PROBE the script took via harness.probe(): a CDP
//              HeapProfiler.collectGarbage → Runtime.getHeapUsage snapshot. The runner
//              owns the CDP calls; the script only marks WHERE to probe. heapPerFrameBytes,
//              bytesPerPoint, and the §6.2 line/candle/slot budgets are 'probe' metrics —
//              deltas between bracketing snapshots, never a per-frame quantity, so they
//              never travel the onFrame stream. (wallMs is a 'frame'-independent scalar the
//              runner times directly: script entry → paint-complete of the last frame.)
export type MetricSource = 'frame' | 'probe';

/** A 'frame'-source metric is any FrameStats lane; 'probe'/scalar metrics name a derived
 *  quantity the runner computes from CDP snapshots or its own wall clock. `layoutFrames` is
 *  a derived 'frame'-source COUNT (not a lane): the number of FrameStats whose `level` is
 *  Layout over the run — the §4.4.6/§4.4.10 "≤ 2 Layout frames total" structural cap (fix #3,
 *  a frame COUNT, distinct from the layoutMs timing sum). */
export type MetricName =
  | keyof FrameStats
  | 'heapPerFrameBytes'
  | 'bytesPerPoint'
  | 'wallMs'
  | 'layoutFrames';

/** Frame gates reduce the frame stream (p95/avg/max/sum/exact); probe gates take the GC
 *  floor (min) across `repeats` runs. The two sets are disjoint by source (perf §9.6). */
export type Aggregate = 'p95' | 'avg' | 'max' | 'sum' | 'exact' | 'min';

/** A 'probe'-source gate's bracketing labels + how the raw Δ (bytes) becomes the gated
 *  value (perf §6.2). `from2`/`to2` appear on the ONE derived gate (the timeline-slot
 *  budget) that subtracts a second Δ from the first. */
export interface ProbeSpec {
  from: string;
  to: string; // value = heapUsed(to) − heapUsed(from)
  from2?: string;
  to2?: string; // derived gate only: value = (to−from)Δ − (to2−from2)Δ
  perFrames?: number; // divide the (possibly derived) Δ by this frame count (heapPerFrameBytes: 300, §5.3)
  perPoints?: number; // divide by this point count (bytesPerPoint / §6.2 budgets: 1e6)
  repeats: number; // run the bracket N times; the gated value is the MIN (GC floor) — pairs with aggregate:'min'
}

/** One regression gate (perf §9.6). `cap` is the absolute hard limit (this doc's tables);
 *  `driftFailPct` (default 20, §9.5) fails on baseline drift. `probe` is present iff
 *  `source === 'probe'` (ignored otherwise). */
export interface MetricGate {
  source: MetricSource;
  metric: MetricName;
  aggregate: Aggregate;
  cap: number;
  driftFailPct?: number; // vs baselines.json; default 20 (§9.5)
  probe?: ProbeSpec; // 'probe'-source only — the bracketing labels + Δ→value reduction
  // When set, this gate passes VACUOUSLY in the current (M9) pipeline and is REPORTED, not gated:
  // the runner prints "[informational until M11: <reason>]" and never counts it as a hard pass
  // (or fail). The counter itself is correct; the value is just not yet meaningful (e.g. a data
  // lane reset before the M9 synchronous data-work, a host source still stubbed to 0). Cleared in
  // M11 when the underlying source/pipeline lands. (perf §9.6 — keep the gate, surface the truth.)
  informationalUntilM11?: string;
}

/** The scene a scenario runs over (the §4.1 fixtures + the non-gating smoke). */
export type SceneId = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'smoke';

/** The chart fixture a scenario script drives (the BenchChart harness.mjs builds; the
 *  runner builds a real-DOM equivalent). Kept structural so node + browser share scripts.
 *  The surface is intentionally narrow — a scenario only mutates data, drives input
 *  through the harness, and (for memory scenarios) marks probe points. */
export interface BenchChart {
  // Mutation the live-tick / burst / setData scenarios use.
  setData(seriesIndex: number, data: readonly unknown[]): void;
  update(seriesIndex: number, point: unknown): void;
  // Interaction the crosshair / wheel / pan / kinetic scenarios drive (device px).
  crosshairMove(x: number, y: number): Promise<void>;
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  pan(dxBars: number): Promise<void>;
  // Drive one scheduled frame and resolve when its paint completes (node: flush the fake
  // rAF; browser: await the rAF + the IPerfSink onFrame for that frame).
  frame(): Promise<void>;
}

/** The harness given to a scenario script (perf §9.6). `probe(label)` is a no-op label the
 *  runner intercepts to issue the bracketing CDP HeapProfiler snapshots — the ONLY way a
 *  CDP-measured Δ reaches a 'probe' MetricGate. Frame-stream scenarios never call it. There
 *  is no second ScenarioSpec subtype for memory: every scenario uses this one shape, and the
 *  gate's `source` selects whether its samples come from onFrame ('frame') or from
 *  probe()-bracketed snapshots ('probe'). */
export interface BenchHarness {
  probe(label: string): Promise<void>;
}

/** A scenario: an id, the scene it runs over, the script that drives it, and the gates it
 *  declares (perf §9.2). The runner runs `script`, collects FrameStats + probe Δs, then
 *  evaluates every gate's aggregate against its cap and baseline drift. */
export interface ScenarioSpec {
  id: string;
  scene: SceneId;
  script(chart: BenchChart, harness: BenchHarness): Promise<void>;
  gates: readonly MetricGate[];
}

// --- gate constructors (terse, typed builders the scenario catalog uses) ----------------

/** A 'frame'-source gate over a FrameStats lane (perf §9.6). */
export function frameGate(
  metric: keyof FrameStats,
  aggregate: Exclude<Aggregate, 'min'>,
  cap: number,
  driftFailPct?: number,
): MetricGate {
  return { source: 'frame', metric, aggregate, cap, driftFailPct };
}

/** A 'frame'-source EXACT structural-invariant gate (perf §4.4 — runner-noise-immune). */
export function exactGate(metric: keyof FrameStats, cap: number): MetricGate {
  return { source: 'frame', metric, aggregate: 'exact', cap, driftFailPct: 0 };
}

/** A 'frame'-source EXACT cap on the COUNT of Layout-level frames over the run (the
 *  §4.4.6/§4.4.10 "≤ 2 Layout frames total" structural cap; fix #3). A hard count, not a
 *  timing — driftFailPct 0, like exactGate. The runner counts FrameStats whose level is
 *  Layout; aggregate 'exact' so the value is that total (run.mjs / structural.mjs special-case
 *  the `layoutFrames` derived metric). Distinct from the layoutMs timing-sum gate. */
export function layoutFrameCountGate(cap: number): MetricGate {
  return { source: 'frame', metric: 'layoutFrames', aggregate: 'exact', cap, driftFailPct: 0 };
}

/** Tag a gate as informational-until-M11: the runner reports it with the given reason and never
 *  counts it as a hard pass/fail (the value is vacuous in the M9 pipeline). Keeps the counter +
 *  cap intact so M11 only needs to drop the wrapper. Returns a NEW gate (the inputs are frozen
 *  records the catalog shares). */
export function markInformationalUntilM11(gate: MetricGate, reason: string): MetricGate {
  return { ...gate, informationalUntilM11: reason };
}

/** A wall-time scalar gate the runner times directly (script entry → last paint; perf §4.2). */
export function wallGate(cap: number, driftFailPct?: number): MetricGate {
  return { source: 'frame', metric: 'wallMs', aggregate: 'max', cap, driftFailPct };
}

/** A 'probe'-source heap gate: the Δ between two probe labels ÷ perFrames/perPoints, min of
 *  `repeats` runs (the §5.3/§6.2 GC-floor reducer). `derived` carries the second pair for
 *  the one timeline-slot gate that subtracts two Δs (perf §6.2 step 4). */
export function probeGate(
  metric: 'heapPerFrameBytes' | 'bytesPerPoint',
  cap: number,
  probe: ProbeSpec,
): MetricGate {
  return { source: 'probe', metric, aggregate: 'min', cap, probe };
}
