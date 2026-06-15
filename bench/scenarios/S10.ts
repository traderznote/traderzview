// bench/scenarios/S10.ts — pan with 50 series (perf §9.2). Scene R3 "breadth" (50 line
// series × 10 k points, one pane, visible 2,000 bars). Sixty Render pan frames — the §4.2
// breadth pan path, p95 ≤ 12 ms, ≤ 4 KB/frame. A pan is steady-state geometry (no data
// mutation), so §4.4.2 also binds: every clean source returns its cached display list by
// identity — cachedListIdentityViolations == 0 across all 50 series (zero-tolerance).
import { scenario, frameGate, exactGate, probeGate } from './_shared';

export default scenario({
  id: 'S10',
  scene: 'R3',
  async script(chart, harness) {
    await harness.probe('windowStart');
    for (let i = 0; i < 60; i++) await chart.pan(5);
    await harness.probe('windowEnd');
  },
  gates: [
    frameGate('totalMs', 'p95', 12), // §4.2 breadth pan p95 (50 series)
    exactGate('cachedListIdentityViolations', 0), // §4.4.2 clean sources never re-emit
    // §4.2 alloc ≤ 4 KB/frame (the §5.3 measured heap window over the steady pan).
    probeGate('heapPerFrameBytes', 4096, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
