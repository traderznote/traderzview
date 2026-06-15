// bench/scenarios/S7.ts — setData replace (perf §9.2). Scene R1 "parity" (5 × 100 k). The
// §4.2 cold-path gate is `setData all series → next painted frame, R1 (5 × 100 k)` ≤ 320 ms:
// replace one series' data and time the wall from the script call to the paint-complete of
// the frame the replace arms. (The §4.2 table's R2 leg — `setData → next painted frame,
// R2 (2 × 1 M)` ≤ 1,600 ms — is the SAME setData path at 1 M scale; it rides S12, which
// already drives three 1 M `setData`s on R2 and measures their cost, so the 1,600 ms cold
// path is covered without a second R2 wall scenario duplicating the data build.)
import { scenario, wallGate } from './_shared';

export default scenario({
  id: 'S7',
  scene: 'R1',
  async script(chart) {
    // Replace series 0's data with a fresh full set (the runner re-feeds the seeded R1
    // candle data); the wall clock brackets script-entry → that frame's paint-complete.
    chart.setData(0, []);
    await chart.frame();
  },
  gates: [
    wallGate(320), // §4.2 cold: setData all series → next painted frame, R1
  ],
});
