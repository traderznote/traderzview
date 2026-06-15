// bench/scenarios/S17.ts — nightly smoke, NON-GATING (perf §9.2 / §6.1 design-intent
// column). Scene `smoke`: the runner sequentially constructs a 5 M-point series, a 200-series
// chart, and a 16-pane chart (the §6.1 design-intent ceilings — no hard caps, memory-bound).
// The script asserts each first paint + one pan frame completes WITHOUT error; wall times are
// REPORTED, never gated (a gated row would contradict §6.1's "design intent, not budget").
// Hence an empty `gates` array — the runner records timings for the nightly report only.
import { scenario, frames } from './_shared';

export default scenario({
  id: 'S17',
  scene: 'smoke',
  async script(chart) {
    await frames(chart, 1); // first paint of the constructed design-intent scene (no error = pass)
    await chart.pan(5); // one pan frame completes (the §9.2 smoke assertion)
  },
  gates: [], // §6.1 design-intent: wall times reported, never gated — no perf gates by design
});
