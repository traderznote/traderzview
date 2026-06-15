// bench/scenarios/S5.ts — live tick, two phases (perf §9.2). Scene R1 "parity", all 5
// series. Phase A: random-walk same-time `update()` ticks at 60 Hz × 10 s (600 frames) —
// the §4.2 live-tick path (p95 ≤ 6 ms, ≤ 4 KB) plus the §4.4.4 mechanism gate (updateLast
// touches no timeline; ≤ 1 min/max chunk recompute per series per tick). Phase B: the
// §4.4.6 digit-boundary square wave — the last price alternates 99.99 / 100.01 holding each
// value for 10 frames (3.0 Hz, deliberately shorter than the N=30-frame shrink damper) for
// 60 s (3600 frames). A correct grow-only axis ratchet grows once to fit the extra digit and
// never shrinks: the run must produce ≤ 2 Layout frames total (expected exactly 1).
import { scenario, frameGate, exactGate, probeGate, layoutFrameCountGate } from './_shared';

const SERIES = 5; // R1 has 5 series (candle + 2 line + area + histogram)

export default scenario({
  id: 'S5',
  scene: 'R1',
  async script(chart, harness) {
    // --- Phase A: 600 same-time live ticks across all 5 series (§4.2 live tick) ---
    await harness.probe('windowStart'); // bracket the §5.3 alloc window over the steady ticks
    for (let i = 0; i < 600; i++) {
      const v = 100 + Math.sin(i * 0.1); // bounded random-walk-like; stays well inside 2 digits
      for (let s = 0; s < SERIES; s++) chart.update(s, { time: 0, value: v });
      await chart.frame();
    }
    await harness.probe('windowEnd');
    // --- Phase B: the §4.4.6 square wave (99.99 ↔ 100.01, hold 10 frames) × 3600 frames ---
    for (let i = 0; i < 3600; i++) {
      const v = Math.floor(i / 10) % 2 === 0 ? 99.99 : 100.01; // digit-boundary crossing
      for (let s = 0; s < SERIES; s++) chart.update(s, { time: 0, value: v });
      await chart.frame();
    }
  },
  gates: [
    frameGate('totalMs', 'p95', 6), // §4.2 phase-A live-tick p95
    exactGate('timelineRebuilds', 0), // §4.4.4 updateLast touches no timeline
    exactGate('chunkRecomputes', SERIES), // §4.4.4 ≤ 1 chunk recompute / series / tick (5 series)
    // §4.4.6 / §4.4.8: ≤ 2 Layout frames over the 60 s phase-B run. The binding cap is a frame
    // COUNT — the grow-only ratchet must fire at most twice (expected exactly 1). fix #3: encode
    // it as a Layout-frame COUNT (was only a layoutMs timing SUM, which counted no frames). The
    // layoutMs sum (≤ 40 ms ≈ 2 layout frames) is kept as a secondary timing guard.
    layoutFrameCountGate(2), // §4.4.6 ≤ 2 Layout frames total
    frameGate('layoutMs', 'sum', 40), // §4.4.6 secondary: total Layout time
    // §4.2 alloc ≤ 4 KB/frame on the live-tick path (the §5.3 measured heap window).
    probeGate('heapPerFrameBytes', 4096, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
