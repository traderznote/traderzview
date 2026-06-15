// bench/scenarios/S12.ts — memory: per-point byte-attribution (perf §9.2 / §6.2). This is
// a 'probe'-source MEMORY scenario, not a frame-time one: the gates are heap deltas between
// bracketing `setData` steps, taken via the runner's CDP HeapProfiler.collectGarbage →
// Runtime.getHeapUsage pair at each harness.probe() (and the node approximation below).
//
// §6.2 protocol (normative), fresh chart, 1 M seeded timestamps T, three series at the SAME
// T so the union time pool is shared:
//   probe('empty')                      — before any data
//   setData(series 0 = line A, 1 M @ T); probe('afterA')  → Δ1 = afterA − empty
//                                          = line lanes + timeline slots (pool was empty)
//   setData(series 1 = line B, 1 M @ T); probe('afterB')  → Δ2 = afterB − afterA
//                                          = line lanes only (pool fully shared)
//   setData(series 2 = candle, 1 M @ T); probe('afterC')  → Δ3 = afterC − afterB
//                                          = candle lanes only
// Gates (perf §6.2, three attributions, each ÷ 1 M, min of 3 runs — the GC floor):
//   • line   ≤ 24 B/pt   = Δ2 / 1 M          (from afterA, to afterB)
//   • candle ≤ 48 B/pt   = Δ3 / 1 M          (from afterB, to afterC)
//   • slot   ≤ 32 B/slot = (Δ1 − Δ2) / 1 M   (the ONE derived gate: two Δs subtracted)
//
// Scene is "R2-sized" (§9.2): a fresh chart whose runner adapter exposes three series —
// line A (index 0), line B (index 1), candlestick (index 2) — all fed the SAME 1 M seeded
// timestamps so series B/candle add only their own lanes (the pool is shared after A).
import { scenario, probeGate } from './_shared';

const POINTS = 1e6; // 1 M points per series (perf §6.2)

export default scenario({
  id: 'S12',
  scene: 'R2',
  async script(chart, harness) {
    await harness.probe('empty'); // before any data — the empty-pool baseline
    chart.setData(0, []); // line A, 1 M @ T → line lanes + timeline slots (pool was empty)
    await harness.probe('afterA');
    chart.setData(1, []); // line B, 1 M @ T → line lanes only (pool now shared)
    await harness.probe('afterB');
    chart.setData(2, []); // candle, 1 M @ T → candle lanes only
    await harness.probe('afterC');
  },
  gates: [
    // Line: Δ2 = afterB − afterA, ÷ 1 M, min of 3 runs ≤ 24 B (perf §6.2 step 2).
    probeGate('bytesPerPoint', 24, { from: 'afterA', to: 'afterB', perPoints: POINTS, repeats: 3 }),
    // Candle: Δ3 = afterC − afterB, ÷ 1 M, min of 3 ≤ 48 B (perf §6.2 step 3).
    probeGate('bytesPerPoint', 48, { from: 'afterB', to: 'afterC', perPoints: POINTS, repeats: 3 }),
    // Timeline slot: (Δ1 − Δ2) = (afterA − empty) − (afterB − afterA), ÷ 1 M, min of 3 ≤ 32 B
    // (perf §6.2 step 4 — the one derived gate, value = (to−from) − (to2−from2)).
    probeGate('bytesPerPoint', 32, {
      from: 'empty', to: 'afterA', from2: 'afterA', to2: 'afterB', perPoints: POINTS, repeats: 3,
    }),
  ],
});
