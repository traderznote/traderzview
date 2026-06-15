// bench/scenarios/S6.ts — 1,000-append burst in one event-loop turn (perf §9.2). Scene R1.
// The 1,000 new-timestamp `update()`s are issued SYNCHRONOUSLY — no `await` between them —
// so they all land in one turn, each merging into the single pending UpdateMask; no frame is
// scheduled until the turn yields (§4.4.5). Then exactly one rAF fires and paints. Two gates:
//   • §4.4.5 coalescing — the burst produces EXACTLY ONE painted frame (the runner checks
//     the FrameStats stream length is 1 for the burst window; declared via `displayLists`
//     exact ≥ on the single frame — see note);
//   • §4.2 wall time ≤ 200 ms, bracketed turn-entry → paint-complete of that one coalesced
//     frame (a `wallMs` scalar the runner times directly, NOT a per-frame totalMs — §4.2's
//     explicit one-shot cold-cost bracket for absorbing a 1,000-deep single-turn backlog).
import { scenario, wallGate, exactGate } from './_shared';

export default scenario({
  id: 'S6',
  scene: 'R1',
  async script(chart) {
    // One synchronous turn: 1,000 new-timestamp appends to series 0. No await between them —
    // they coalesce into one pending mask (§4.4.5); the frame is scheduled only when the turn
    // yields at the `await` below.
    for (let i = 0; i < 1000; i++) chart.update(0, { time: 1_000_000 + i, value: 100 + i * 0.01 });
    await chart.frame(); // the ONE coalesced frame the yielded turn paints
  },
  gates: [
    wallGate(200), // §4.2: turn-entry → paint-complete of the single coalesced frame
    // §4.4.5: exactly one display-list composite on the one painted frame. The runner also
    // asserts the burst window yielded a single FrameStats; this `displayLists` exact gate
    // pins that the one frame did composite (≥ 1 list) and that there was no second frame
    // (the exact ceiling holds per-frame — a stray inter-frame paint would exceed it).
    // NOTE: the displayLists cap alone does not PROVE the single-frame count; the explicit
    // "burst paints exactly one frame" assertion is in bench/structural.mjs (§4.4.5, fix #9),
    // which drives this exact pattern headless and asserts frames.length grew by exactly 1.
    exactGate('displayLists', 5), // R1 has 5 series → ≤ 5 display lists on the single frame
  ],
});
