// bench/scenarios/_shared.ts — helpers shared by the per-scenario frame-time scripts
// (perf §9.2). Re-exports the gate model + builders so each scenario file imports from one
// place, and a `frames(chart, n)` driver every Render/Layout scenario uses to drive a fixed
// number of painted frames (each `await chart.frame()` resolves at that frame's paint).
// Tiny on purpose — bench/ is a workspace package outside the LOC budget (perf §9.1).
import type { BenchChart, ScenarioSpec } from '../gates';

export type { BenchChart, BenchHarness, MetricGate, ScenarioSpec } from '../gates';
export { frameGate, exactGate, wallGate, probeGate, layoutFrameCountGate } from '../gates';

/** Drive `n` painted frames; each `await chart.frame()` resolves when that frame paints. */
export async function frames(chart: Pick<BenchChart, 'frame'>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await chart.frame();
}

/** A typed identity helper so a per-scenario file reads as `export default scenario({...})`. */
export function scenario(spec: ScenarioSpec): ScenarioSpec {
  return spec;
}
