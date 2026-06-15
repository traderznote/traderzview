// bench/scenarios.ts — the scenario catalog S1–S17 (perf §9.2). Each ScenarioSpec pairs a
// scene (§4.1) with a script (the interaction it drives) and the gates it declares (the
// §4.2 frame budgets, §4.4 structural invariants, §6.2 memory budgets). The scripts run in
// the browser page (run.mjs bundles them into the driver); run.mjs reads the gate records
// as plain data. This file is the single source of truth for "what fails a PR" (§9.3).
//
// Gate caps are quoted verbatim from the §4.2 / §4.4 / §6.2 tables. Drift policy is §9.5
// (warn > 10%, fail > driftFailPct ?? 20); the exact structural gates set driftFailPct 0
// (they are hard counts, not timings — perf §4.4 "immune to runner noise").
import type { ScenarioSpec } from './gates';
import { frameGate, exactGate, wallGate, probeGate, layoutFrameCountGate, markInformationalUntilM11 } from './gates';

// Reasons the vacuous-until-M11 gates carry (the counters are correct; the VALUES are not yet
// meaningful in the M9 pipeline). run.mjs reports these and never counts them as a hard pass.
const INFO_INPUT_LAG = 'host input-lag source — inputLagFrames is hardcoded () => 0 in create-chart.ts until M11 wires it';
const INFO_DATA_LANE = 'data-work moves into applyRender — these data lanes (timelineRebuilds/chunkRecomputes) are reset at frame entry while M9 does setData/update data-work synchronously before the frame, so they read 0 vacuously';
const INFO_ID_VIOLATIONS = 'per-frame dirtiness tracking — the live composite path never bumps cachedListIdentityViolations (only assertCleanIdentity does), so the lane reads 0 vacuously';

// Drive a fixed number of paint frames (each `await chart.frame()` resolves at paint).
async function frames(chart: { frame(): Promise<void> }, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await chart.frame();
}

export const SCENARIOS: readonly ScenarioSpec[] = [
  // S1 — cold init → first paint (R0, R1). Cold-path wall times (§4.2).
  {
    id: 'S1',
    scene: 'R0',
    async script(chart) { await chart.frame(); },
    gates: [wallGate(60)], // createChart → first painted frame, R0 (§4.2 cold paths)
  },

  // S2 — crosshair sweep, 120 moves, ZERO listeners (R1). Overlay p95 ≤ 4 ms, ≤ 512 B,
  // §4.4.1 (0 base re-emit), §4.4.3 (≤ 40 cmds/Overlay frame), §4.4.9 (lag ≤ 2).
  {
    id: 'S2',
    scene: 'R1',
    async script(chart) {
      for (let i = 0; i < 120; i++) { await chart.crosshairMove(200 + i * 10, 300); }
    },
    gates: [
      frameGate('totalMs', 'p95', 4),
      frameGate('drawCommands', 'max', 40), // §4.4.3 Overlay ≤ 40
      markInformationalUntilM11(exactGate('inputLagFrames', 2), INFO_INPUT_LAG), // §4.4.9 (fix #7)
      probeGate('heapPerFrameBytes', 512, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
    ],
  },

  // S2b — crosshair sweep, 120 moves, ONE crosshairMoved listener (R1). Overlay p95 ≤ 4 ms
  // unchanged; SEPARATE alloc gate ≤ 2 KB/frame (the A3 one-listener payload, §4.2/§5.1).
  {
    id: 'S2b',
    scene: 'R1',
    async script(chart) {
      for (let i = 0; i < 120; i++) { await chart.crosshairMove(200 + i * 10, 300); }
    },
    gates: [
      frameGate('totalMs', 'p95', 4),
      probeGate('heapPerFrameBytes', 2048, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
    ],
  },

  // S3 — wheel zoom, 60 events anchored; zoom-out leg ends ≥ 3000 visible bars (R1). Render
  // p95 ≤ 10 ms, ≤ 4 KB, §4.4.9; golden wheel-normalization values (the node microbench).
  {
    id: 'S3',
    scene: 'R1',
    async script(chart) {
      for (let i = 0; i < 60; i++) { await chart.wheel(800, 450, i < 30 ? -120 : 120); }
    },
    gates: [
      frameGate('totalMs', 'p95', 10),
      markInformationalUntilM11(exactGate('inputLagFrames', 2), INFO_INPUT_LAG), // §4.4.9 (fix #7)
      probeGate('heapPerFrameBytes', 4096, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
    ],
  },

  // S4 — kinetic fling → settle (R1). Glide p95 ≤ 8 ms, §4.4.7 (0 reallocs after warm-up).
  {
    id: 'S4',
    scene: 'R1',
    async script(chart) {
      await chart.pan(40); // initiate a fling; the kinetic animation re-arms until settle
      await frames(chart, 60);
    },
    gates: [
      frameGate('totalMs', 'p95', 8),
      exactGate('bufferReallocs', 0), // §4.4.7 buffer steady state
    ],
  },

  // S5 — live tick, two phases (R1). A: random-walk ticks 60 Hz × 10 s; B: digit-boundary
  // square wave 60 Hz × 60 s. A: live p95 ≤ 6 ms, §4.4.4; B: §4.4.6 (≤ 2 Layout frames/60 s).
  {
    id: 'S5',
    scene: 'R1',
    async script(chart) {
      // Phase A — same-time updateLast on all 5 series, 600 ticks.
      for (let i = 0; i < 600; i++) {
        for (let s = 0; s < 5; s++) chart.update(s, { time: 0, value: 100 + Math.sin(i) });
        await chart.frame();
      }
      // Phase B — square wave alternating 99.99 / 100.01, holding each 10 frames, 3600 frames.
      for (let i = 0; i < 3600; i++) {
        const v = Math.floor(i / 10) % 2 === 0 ? 99.99 : 100.01;
        for (let s = 0; s < 5; s++) chart.update(s, { time: 0, value: v });
        await chart.frame();
      }
    },
    gates: [
      frameGate('totalMs', 'p95', 6), // phase A live tick
      // §4.4.4 data lanes — informational until M11 (fix #5): reset at frame entry, but M9 runs
      // the updateLast data-work synchronously BEFORE the frame, so both read 0 vacuously.
      markInformationalUntilM11(exactGate('timelineRebuilds', 0), INFO_DATA_LANE),
      markInformationalUntilM11(exactGate('chunkRecomputes', 1), INFO_DATA_LANE),
      // §4.4.6 (phase B): the binding cap is a frame COUNT — ≤ 2 Layout frames over the 60 s
      // run (the digit-boundary square wave must ratchet the axis label width at most twice).
      // fix #3: encode it as a Layout-frame COUNT (was a layoutMs timing SUM that did not
      // actually count frames). The layoutMs sum is kept as a secondary timing guard.
      layoutFrameCountGate(2), // §4.4.6 ≤ 2 Layout frames total
      frameGate('layoutMs', 'sum', 40), // §4.4.6 secondary: total Layout time (a layout frame ~20 ms)
    ],
  },

  // S6 — 1000-append burst in one turn (R1). Coalescing §4.4.5 (single painted frame); burst
  // wall time ≤ 200 ms turn-entry → that frame's paint-complete (§4.2 bracket, a wallMs gate).
  {
    id: 'S6',
    scene: 'R1',
    async script(chart) {
      for (let i = 0; i < 1000; i++) chart.update(0, { time: 1000 + i, value: 100 + i * 0.01 });
      await chart.frame(); // the ONE coalesced frame the turn yields to
    },
    gates: [
      wallGate(200), // §4.2 turn-entry → paint-complete
      // §4.4.5 single painted frame is asserted by the driver (frame count === 1), surfaced
      // as displayLists ≥ 1 on exactly one frame — the runner checks frames.length === 1.
    ],
  },

  // S7 — setData replace (R1, R2). Cold-path wall times (§4.2).
  {
    id: 'S7',
    scene: 'R1',
    async script(chart) { chart.setData(0, []); await chart.frame(); },
    gates: [wallGate(320)], // setData all series to next painted frame, R1 (5 × 100 k)
  },

  // S8 — fitContent on R2 + pan (R2). Decimated pan p95 ≤ 16 ms; command-count ≤ 60 (§4.4.3).
  {
    id: 'S8',
    scene: 'R2',
    async script(chart) { for (let i = 0; i < 60; i++) await chart.pan(5); },
    gates: [
      frameGate('totalMs', 'p95', 16),
      frameGate('drawCommands', 'max', 60), // §4.4.3 decimated R2 Render pan ≤ 60
      markInformationalUntilM11(exactGate('cachedListIdentityViolations', 0), INFO_ID_VIOLATIONS), // §4.4.2 (fix #6)
    ],
  },

  // S9 — resize drag, 40 steps (R1). Layout p95 ≤ 20 ms (§4.2).
  {
    id: 'S9',
    scene: 'R1',
    async script(chart) { await frames(chart, 40); },
    gates: [frameGate('totalMs', 'p95', 20)],
  },

  // S10 — pan with 50 series (R3). Breadth p95 ≤ 12 ms (§4.2).
  {
    id: 'S10',
    scene: 'R3',
    async script(chart) { for (let i = 0; i < 60; i++) await chart.pan(5); },
    gates: [
      frameGate('totalMs', 'p95', 12),
      markInformationalUntilM11(exactGate('cachedListIdentityViolations', 0), INFO_ID_VIOLATIONS), // §4.4.2 (fix #6)
    ],
  },

  // S11 — applyOptions color change every frame, 5 s (R1). ≤ 6 ms/frame; 0 PlotStore writes.
  {
    id: 'S11',
    scene: 'R1',
    async script(chart) { for (let i = 0; i < 300; i++) await chart.frame(); },
    gates: [
      frameGate('totalMs', 'p95', 6),
      // §4.4.4 — informational until M11 (fix #5): an option change dirties the source only, but
      // the lane is reset at frame entry while M9 runs the data-work synchronously before the frame.
      markInformationalUntilM11(exactGate('timelineRebuilds', 0), INFO_DATA_LANE),
    ],
  },

  // S12 — memory: per-budget attribution protocol (§6.2 steps 1–4). Line / candle / slot
  // budgets are 'probe'-source deltas between bracketing setData steps (the §6.2 worked bridge).
  {
    id: 'S12',
    scene: 'R2',
    async script(chart, harness) {
      await harness.probe('empty');
      chart.setData(0, []); await harness.probe('afterA'); // line A, 1 M (lanes + timeline slots)
      chart.setData(1, []); await harness.probe('afterB'); // line B, 1 M (lanes only — pool shared)
      chart.setData(2, []); await harness.probe('afterC'); // candle, 1 M (candle lanes only)
    },
    gates: [
      probeGate('bytesPerPoint', 24, { from: 'afterA', to: 'afterB', perPoints: 1e6, repeats: 3 }), // line ≤ 24 B
      probeGate('bytesPerPoint', 48, { from: 'afterB', to: 'afterC', perPoints: 1e6, repeats: 3 }), // candle ≤ 48 B
      // timeline slot = (afterA−empty) − (afterB−afterA), ÷1 M, min of 3 — the one derived gate.
      // reduceProbe computes value = (to−from) − (to2−from2), so the bracketing pairs are
      // empty→afterA (= Δ1, lanes+slots) MINUS afterA→afterB (= Δ2, lanes only) = the slot Δ.
      // (Inverting these to afterA→empty / afterB→afterA negates the value — fix #1.)
      probeGate('bytesPerPoint', 32, {
        from: 'empty', to: 'afterA', from2: 'afterA', to2: 'afterB', perPoints: 1e6, repeats: 3,
      }),
    ],
  },

  // S13 — pan (60) + crosshair sweep (120) across 4 panes (R4). 4-pane Render/Overlay p95.
  {
    id: 'S13',
    scene: 'R4',
    async script(chart) {
      for (let i = 0; i < 60; i++) await chart.pan(5);
      for (let i = 0; i < 120; i++) await chart.crosshairMove(200 + i * 10, 300);
    },
    gates: [
      frameGate('totalMs', 'p95', 10),
      markInformationalUntilM11(exactGate('cachedListIdentityViolations', 0), INFO_ID_VIOLATIONS), // §4.4.2 (fix #6)
    ],
  },

  // S14 — live tick 60 Hz × 10 s across all 20 series (R5). 20-series live p95 ≤ 8 ms, §4.4.4.
  {
    id: 'S14',
    scene: 'R5',
    async script(chart) {
      for (let i = 0; i < 600; i++) {
        for (let s = 0; s < 20; s++) chart.update(s, { time: 0, value: 100 + Math.sin(i + s) });
        await chart.frame();
      }
    },
    gates: [
      frameGate('totalMs', 'p95', 8),
      markInformationalUntilM11(exactGate('timelineRebuilds', 0), INFO_DATA_LANE), // §4.4.4 (fix #5)
    ],
  },

  // S15 — sustained burst: 84 update() per rAF for 5 s (~5000/s) (R1). One painted frame per
  // rAF (§4.4.5), sustained-burst p95 ≤ 6 ms (§4.2).
  {
    id: 'S15',
    scene: 'R1',
    async script(chart) {
      for (let f = 0; f < 300; f++) {
        for (let i = 0; i < 84; i++) chart.update(0, { time: 2000 + f * 84 + i, value: 100 });
        await chart.frame(); // exactly one painted frame per rAF period (§4.4.5)
      }
    },
    gates: [frameGate('totalMs', 'p95', 6)],
  },

  // S16 — crosshair sweep (120) + pan (60) with 100 price lines + 10 k markers (R6). R6
  // Overlay/Render p95; drawCommands O(visible markers) not O(10 k); §4.4.10 price-line gates.
  {
    id: 'S16',
    scene: 'R6',
    async script(chart) {
      for (let i = 0; i < 120; i++) await chart.crosshairMove(200 + i * 10, 300); // Overlay
      for (let i = 0; i < 60; i++) await chart.pan(5); // Render pan
    },
    gates: [
      frameGate('totalMs', 'p95', 12), // R6 Render pan p95 (the binding p95; Overlay ≤ 4 also holds)
      frameGate('drawCommands', 'max', 220), // §4.4.10/§4.4.3: O(runs)+O(priceLines)+O(visible markers), not O(10 k)
      // §4.4.10: the static-label-width ratchet must produce ≤ 2 Layout frames over the run.
      // fix #3: a Layout-frame COUNT (was a layoutMs timing SUM). The layoutMs sum is kept too.
      layoutFrameCountGate(2), // §4.4.10 ≤ 2 Layout frames total (static label width ratchet)
      frameGate('layoutMs', 'sum', 40), // §4.4.10 secondary: total Layout time
      markInformationalUntilM11(exactGate('cachedListIdentityViolations', 0), INFO_ID_VIOLATIONS), // §4.4.2 (fix #6)
    ],
  },

  // S17 — nightly smoke, NON-GATING (§9.2): 5 M series, 200-series chart, 16-pane chart;
  // assert first paint + one pan frame complete without error; wall times reported only.
  {
    id: 'S17',
    scene: 'smoke',
    async script(chart) { await chart.frame(); await chart.pan(5); },
    gates: [], // design-intent column (§6.1) — no perf gates by design
  },
];
