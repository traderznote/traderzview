// bench/scenarios/S4.ts — kinetic fling → settle (perf §9.2). Scene R1 "parity". A pan
// gesture initiates a fling; the kinetic animation (model/time-scale/navigator.ts, the
// study 10 §4.12 closed-form decay) re-arms a Render frame each rAF until it settles. The
// §4.2 budget for the glide path is p95 ≤ 8 ms, ≤ 2 KB/frame. The glide is a STEADY-STATE
// path (no data mutation, no resize), so §4.4.7 also binds: bufferReallocs == 0 after the
// 10-frame warm-up drop (the §4.3 aggregation drops the first 10 frames; the exact gate
// asserts a hard 0 on every retained frame — runner-noise-immune).
import { scenario, frameGate, exactGate, probeGate, frames } from './_shared';

export default scenario({
  id: 'S4',
  scene: 'R1',
  async script(chart) {
    await chart.pan(40); // initiate the fling; the kinetic settle re-arms frames until rest
    await frames(chart, 60); // glide → settle (closed-form duration sanity-checked, §9.2)
  },
  gates: [
    frameGate('totalMs', 'p95', 8), // §4.2 kinetic-scroll glide p95
    exactGate('bufferReallocs', 0), // §4.4.7 buffer steady state (0 after warm-up)
    // §4.2 alloc ≤ 2 KB/frame — the §5.3 measured heap gate over a 300-frame window.
    probeGate('heapPerFrameBytes', 2048, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
