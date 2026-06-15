// bench/scenarios/S1.ts — cold init → first paint (perf §9.2). Scene R0 (empty chart,
// 1600×900, DPR 2). The gate is the §4.2 COLD-PATH wall time `createChart → first painted
// frame, R0` ≤ 60 ms — a `wallMs` scalar the runner times from script entry to the
// paint-complete of the one frame the script awaits (§4.2 cold-paths table, not a per-frame
// p95). The R1 cold-init legs (setData all series ≤ 320 ms, setData R2 ≤ 1600 ms) are
// gated by S7 (setData replace) so each cold cost has exactly one owning scenario.
import { scenario, wallGate } from './_shared';

export default scenario({
  id: 'S1',
  scene: 'R0',
  // The scene fixture is already built (the harness paints the initial Layout frame before
  // handing the chart over); the runner's wall clock starts at script entry, so this single
  // awaited frame is the "first painted frame" the §4.2 R0 cold cap brackets.
  async script(chart) {
    await chart.frame();
  },
  gates: [
    wallGate(60), // §4.2 cold: createChart → first painted frame, R0
  ],
});
