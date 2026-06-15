// bench/scenarios/S11.ts — applyOptions color change every frame, 5 s (perf §9.2, fix #4).
// Scene R1 "parity". Every frame an option (a series color) changes; the §5.2/§8-#4 fix says
// an option change dirties the source and re-emits over the VISIBLE range only — it never
// clones item arrays or writes the PlotStore geometry lanes. Gates: §4.2-class ≤ 6 ms/frame
// (the option-change frame budget, table row "Live tick … Render 6 ms" class — fix #4's
// explicit cap), and the mechanism proof that no data-layer rebuild happened: 0 timeline
// rebuilds (an option change must not touch the store/timeline — that would be the cloned-
// array regression #4 designs out). 5 s × 60 Hz = 300 frames.
//
// The color flip per frame is driven by the runner's scene adapter (applyOptions is a chart
// API, not a BenchChart method — the abstract surface only advances frames); each
// `chart.frame()` here is one such option-dirtied Render frame.
import { scenario, frameGate, exactGate } from './_shared';

export default scenario({
  id: 'S11',
  scene: 'R1',
  async script(chart) {
    for (let i = 0; i < 300; i++) await chart.frame(); // 300 option-dirtied Render frames
  },
  gates: [
    frameGate('totalMs', 'p95', 6), // fix #4: ≤ 6 ms/frame on an every-frame option change
    exactGate('timelineRebuilds', 0), // fix #4: an option change dirties the source only (0 store writes)
  ],
});
