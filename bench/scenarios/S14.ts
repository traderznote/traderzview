// bench/scenarios/S14.ts — live tick 60 Hz × 10 s across all 20 series (perf §9.2). Scene
// R5 "fanout" (20 line series × 10 k points, one pane, visible 1,000). Same-time
// `update()` on every series each frame for 600 frames — the §4.2 20-series live path
// (p95 ≤ 8 ms, ≤ 4 KB/frame) plus the §4.4.4 mechanism: a same-time updateLast touches no
// timeline (0 rebuilds) and recomputes ≤ 1 min/max chunk per series per tick.
import { scenario, frameGate, exactGate, probeGate } from './_shared';

const SERIES = 20; // R5 fanout

export default scenario({
  id: 'S14',
  scene: 'R5',
  async script(chart, harness) {
    await harness.probe('windowStart');
    for (let i = 0; i < 600; i++) {
      for (let s = 0; s < SERIES; s++) chart.update(s, { time: 0, value: 100 + Math.sin(i * 0.1 + s) });
      await chart.frame();
    }
    await harness.probe('windowEnd');
  },
  gates: [
    frameGate('totalMs', 'p95', 8), // §4.2 20-series live-tick p95
    exactGate('timelineRebuilds', 0), // §4.4.4 updateLast touches no timeline
    exactGate('chunkRecomputes', SERIES), // §4.4.4 ≤ 1 chunk recompute / series / tick (20 series)
    // §4.2 alloc ≤ 4 KB/frame on the 20-series live path (the §5.3 measured heap window).
    probeGate('heapPerFrameBytes', 4096, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
