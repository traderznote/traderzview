// bench/scenarios/S13.ts — pan (60 frames) + crosshair sweep (120 moves) across 4 panes
// (perf §9.2). Scene R4 "depth" (4 panes; candle+line / histogram / line / area; 100 k pts
// each; visible 1,000). Two §4.2 4-pane rows: Render pan p95 ≤ 10 ms (≤ 4 KB), Overlay
// crosshair p95 ≤ 4 ms (≤ 512 B). The binding p95 across the combined stream is the Render
// cap (10 ms; the cheaper Overlay frames sit under it), so the `totalMs` p95 gate is 10 ms;
// the Overlay alloc cap is gated separately over a heap window bracketing only the crosshair
// phase. §4.4.1–3 also hold (clean sources never re-emit → identity violations 0).
import { scenario, frameGate, exactGate, probeGate } from './_shared';

export default scenario({
  id: 'S13',
  scene: 'R4',
  async script(chart, harness) {
    // Render pan phase (4-pane pan ≤ 10 ms).
    for (let i = 0; i < 60; i++) await chart.pan(5);
    // Overlay crosshair phase (4-pane crosshair ≤ 4 ms, ≤ 512 B) — bracket the alloc window
    // over ONLY this phase so the 512 B Overlay cap is not diluted by the Render frames.
    await harness.probe('windowStart');
    for (let i = 0; i < 120; i++) await chart.crosshairMove(200 + i * 10, 300);
    await harness.probe('windowEnd');
  },
  gates: [
    frameGate('totalMs', 'p95', 10), // §4.2 4-pane Render pan p95 (the binding cap across the stream)
    exactGate('cachedListIdentityViolations', 0), // §4.4.2 clean sources never re-emit
    // §4.2 4-pane Overlay crosshair alloc ≤ 512 B/frame (the §5.3 heap window over the sweep).
    probeGate('heapPerFrameBytes', 512, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
