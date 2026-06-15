// bench/scenarios/S9.ts — resize drag, 40 steps (perf §9.2). Scene R1 "parity". Forty
// separator/container resize steps, each a Layout-level frame (the §4.2 resize-drag path,
// p95 ≤ 20 ms — the only Layout-level interactive budget). Each `chart.frame()` here is a
// Layout frame the runner arms by stepping the container/separator size before awaiting the
// paint (the real runner drives the ResizeObserver; the abstract BenchChart only needs to
// advance one painted frame per step). §9.2 also asserts the paint happens SYNCHRONOUSLY
// inside the RO callback — surfaced by the runner's synchronous-repaint instrumentation
// flag (study 05 §3.2), not a FrameStats lane, so it is not a MetricGate here.
import { scenario, frameGate, frames } from './_shared';

export default scenario({
  id: 'S9',
  scene: 'R1',
  async script(chart) {
    await frames(chart, 40); // 40 resize steps → 40 Layout frames (the runner resizes per step)
  },
  gates: [
    frameGate('totalMs', 'p95', 20), // §4.2 resize-drag Layout p95
  ],
});
