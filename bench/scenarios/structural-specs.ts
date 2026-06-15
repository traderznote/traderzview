// bench/scenarios/structural-specs.ts — the STRUCTURAL-invariant scenario scripts (perf §9.2
// + §4.4): S2, S2b, S3, S8, S15, S16, each a ScenarioSpec whose `gates` are the EXACT-COUNTER
// caps that run HEADLESS now (perf §9.1 — runner-noise-immune FrameStats counts, not timings).
//
// These are the structural slice of the full §9.2 catalog (bench/scenarios.ts). The full specs
// also carry p95 time gates and 'probe' heap gates — those need the throttled browser runner
// (run.mjs) and CDP, so they are NOT in this slice. Here every gate is a 'frame'-source EXACT
// or MAX cap on a FrameStats count lane, asserted by bench/scenarios/structural.mjs against a
// stub-backend chart with __TV_PROFILE__=true (reads frameCounters, like scripts/demo-chart.mjs).
//
// The scripts drive the abstract BenchChart (gates.ts). The node adapter (node-adapter.mjs)
// maps each call to a headless frame; the browser driver (browser/driver.ts) maps it to a real
// canvas frame. The SAME script text runs in both — only the backend differs.
//
// erasableSyntaxOnly: no enums, type-only imports split (verbatimModuleSyntax). bench/ is a
// workspace package outside the §3.1 import wall — it reaches ../src directly, never shipped.
import type { ScenarioSpec, BenchChart } from '../gates';
import { exactGate, frameGate } from '../gates';

// Drive `n` crosshair moves across the pane (the Overlay sweep S2/S2b/S16 share).
async function crosshairSweep(chart: BenchChart, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await chart.crosshairMove(200 + i * 10, 300);
}

// Drive `n` Render-level pan frames (S8/S16). Headless: a Render-frame proxy (node-adapter.mjs);
// browser: a real scroll. The COUNTS a pan exercises (§4.4.2/§4.4.3) are what these gates read.
async function panRun(chart: BenchChart, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await chart.pan(5);
}

// S2 — crosshair sweep, 120 moves, ZERO listeners (R1). The Overlay structural invariants:
//   §4.4.1 — an Overlay frame re-emits ZERO base-band sources (base series untouched). Headless
//            this is exact: the PaneScene composites bands 6–8 only at Overlay scope, so base
//            series sources are never visited → sourcesReEmitted counts only overlay sources.
//   §4.4.3 — an Overlay frame emits ≤ 40 DrawCommands total.
//   §4.4.9 — input-to-pixel ≤ 2 rAF (inputLagFrames; host-stubbed 0 now → trivially ≤ 2).
const S2: ScenarioSpec = {
  id: 'S2',
  scene: 'R1',
  async script(chart) {
    await crosshairSweep(chart, 120);
  },
  gates: [
    // §4.4.1 base-only: an Overlay frame's re-emitted base-band sources is 0 — asserted by the
    // runner from the scene's base-source set (the overlay-only composite leaves them at 0).
    frameGate('drawCommands', 'max', 40), // §4.4.3 Overlay ≤ 40
    exactGate('inputLagFrames', 2), // §4.4.9
    exactGate('cachedListIdentityViolations', 0), // §4.4.2 clean sources never re-emit
  ],
};

// S2b — crosshair sweep, 120 moves, ONE crosshairMoved listener (R1). Same Overlay structural
// invariants as S2 (the +2 KB alloc the listener payload costs is a 'probe' gate, browser-only):
// §4.4.1 still 0 base re-emit, §4.4.3 ≤ 40 cmds. The listener is attached in the script so the
// lazy hasListeners() payload path (A3) runs — proving it does not promote the Overlay frame to
// touch base bands.
const S2b: ScenarioSpec = {
  id: 'S2b',
  scene: 'R1',
  async script(chart, harness) {
    // The one (empty-body) listener: attached via the harness's optional subscribe hook when the
    // adapter exposes it; the node adapter wires it through chart so the §A3 payload path runs.
    await harness.probe('listenerAttached'); // node adapter intercepts → attaches the listener
    await crosshairSweep(chart, 120);
  },
  gates: [
    frameGate('drawCommands', 'max', 40), // §4.4.3 Overlay ≤ 40, unchanged by the listener
    exactGate('cachedListIdentityViolations', 0), // §4.4.2
  ],
};

// S3 — wheel zoom, 60 events anchored (R1). Render-path structural invariants:
//   §4.4.2 — clean sources never re-emit a non-identical list (cachedListIdentityViolations 0).
//   §4.4.9 — input-to-pixel ≤ 2 rAF.
//   §4.4.3 — a Render frame in R1 emits ≤ 120 DrawCommands total (O(runs), not O(bars)).
// The EXACT wheel-normalization VALUES are the micro/goldens.mjs golden, not a structural count.
const S3: ScenarioSpec = {
  id: 'S3',
  scene: 'R1',
  async script(chart) {
    for (let i = 0; i < 60; i++) await chart.wheel(800, 450, i < 30 ? -120 : 120);
  },
  gates: [
    frameGate('drawCommands', 'max', 120), // §4.4.3 R1 Render ≤ 120
    exactGate('inputLagFrames', 2), // §4.4.9
    exactGate('cachedListIdentityViolations', 0), // §4.4.2
  ],
};

// S8 — fitContent on R2 (decimated) + pan (R2). Decimated-Render command-count cap:
//   §4.4.3 — a decimated R2 Render pan frame emits ≤ 60 DrawCommands (decimation collapses each
//            series to one O(deviceWidth) stream + axis/grid runs — LOWER than R1's 120).
//   §4.4.2 — clean sources never re-emit (cachedListIdentityViolations 0).
// INFORMATIONAL-UNTIL-M11: the ≤ 60 decimated cap depends on the §6.3 emit-time decimation path
// (R2 sub-pixel spacing → SeriesKind.decimate), an M11 feature. Until then the node R2 Render
// frame uses the non-decimated emit, so the ≤ 60 cap is reported, not gated (the runner logs it).
const S8: ScenarioSpec = {
  id: 'S8',
  scene: 'R2',
  async script(chart) {
    await panRun(chart, 60);
  },
  gates: [
    frameGate('drawCommands', 'max', 60), // §4.4.3 decimated R2 Render ≤ 60 (M11: decimation)
    exactGate('cachedListIdentityViolations', 0), // §4.4.2 (gates now)
  ],
};

// S15 — sustained burst: 84 update() per rAF for 5 s (~5,000/s) (R1). The coalescing invariant:
//   §4.4.5 — exactly ONE painted frame per rAF period (the 84 appends in a turn merge into one
//            pending mask; the frame paints only once when the turn yields). Headless: each inner
//            loop issues 84 new-timestamp update()s with NO flush, then ONE frame() flushes the
//            single armed frame — the runner asserts exactly one painted frame per frame() turn
//            (60 turns → 60 painted frames, never 2×84 or an inter-frame paint).
//   §4.4.4 — the incremental-append path leaves timelineRebuilds 0 (study 02 §6 O(log N) insert /
//            weight-refill-from-index, not a full timeline rebuild — the §6-fix of IMPROVE #7).
const S15: ScenarioSpec = {
  id: 'S15',
  scene: 'R1',
  async script(chart) {
    let base = 100_000; // past the R1 window's end → genuine appends, not updateLast
    for (let f = 0; f < 60; f++) {
      for (let i = 0; i < 84; i++) chart.update(0, { time: base + f * 84 + i, value: 100 });
      await chart.frame(); // exactly one painted frame per rAF period (§4.4.5)
    }
  },
  gates: [
    // §4.4.4 incremental append, no full timeline rebuild. INFORMATIONAL-UNTIL-M11: the
    // timelineRebuilds lane is reset to 0 at FRAME ENTRY (frame-scheduler.ts), but the M9
    // pipeline does the update()/setData data-work SYNCHRONOUSLY before the frame is scheduled,
    // so any rebuild bump happens BEFORE reset and the frame always reads 0 — the assertion is
    // vacuous (it cannot fail). In M11 the data-work moves into the host applyRender step (inside
    // the frame, after reset) and this lane carries the real per-frame value, gating for real.
    exactGate('timelineRebuilds', 0),
    exactGate('cachedListIdentityViolations', 0), // §4.4.2
  ],
};

// S16 — crosshair sweep (120) + pan (60) with 100 price lines + 10 k markers (R6). §4.4.10:
//   - price-line + back-label sources emit on the BASE band only, O(priceLines), and re-emit
//     ZERO at Overlay scope (an Overlay crosshair frame touches bands 6–8 only — the same
//     §4.4.1 mechanism, applied to price lines: their sources sit in bands 0–5 and are never
//     visited at Overlay scope).
//   - drawCommands stays O(visible markers) + O(priceLines) + O(runs), NOT O(10 k): a Render pan
//     frame's command count is bounded (cap 220), independent of the 10 k total markers.
//   - §4.4.2 clean price lines return cached lists by identity on every pan frame.
// INFORMATIONAL-UNTIL-M11: the price-line + marker SceneSource RENDERING is M11 parity (the M9
// createPriceLine handle contract is live, but its scene source is not yet composited; markers'
// setMarkers is the §13 extras seam, absent on a bare M9 handle). So the price-line/marker HALF
// of the command-count cap (220) is reported, not gated, until M11; the §4.4.1/§4.4.2 base-only
// + identity invariants on the R6 BASE topology (the R1 series under it) gate now.
const S16: ScenarioSpec = {
  id: 'S16',
  scene: 'R6',
  async script(chart) {
    await crosshairSweep(chart, 120); // Overlay
    await panRun(chart, 60); // Render pan
  },
  gates: [
    frameGate('drawCommands', 'max', 220), // §4.4.10/§4.4.3 O(runs)+O(priceLines)+O(visible) (M11: price-line/marker emit)
    exactGate('cachedListIdentityViolations', 0), // §4.4.2 (gates now)
  ],
};

/** The structural-invariant scenario slice (perf §9.2 / §4.4) the node runner gates. */
export const STRUCTURAL_SCENARIOS: readonly ScenarioSpec[] = [S2, S2b, S3, S8, S15, S16];

/** Which scenarios carry an informational-until-M11 gate the runner REPORTS rather than gates.
 *  Each entry maps a `metric:aggregate` gate key to the M11 reason it is not yet a hard pass.
 *  The runner prints "[informational until M11: <reason>]" for these — it never lets one count
 *  as a silent hard pass (even when the current value happens to be within the cap), because
 *  the pass is vacuous until the M11 feature lands. Two distinct flavors live here:
 *   • CAP-DEPENDS-ON-M11 (S8/S16 drawCommands): the cap needs an M11 feature (decimation /
 *     price-line + marker scene-source emit) — the current value is meaningful but the cap is not.
 *   • VACUOUS-LANE (S15 timelineRebuilds): the lane is reset at frame entry while the M9 pipeline
 *     does data-work synchronously BEFORE the frame, so the lane always reads 0 — the assertion
 *     cannot fail until M11 moves data-work into applyRender (inside the frame). */
// The §4.4.2 cachedListIdentityViolations lane is only ever bumped by PaneScene.assertCleanIdentity
// (an inspection hook); the LIVE composite() path never calls it, so the lane reads 0 on every
// frame regardless — its zero-tolerance gate is vacuous until M11 wires per-frame dirtiness
// tracking. Every scenario that declares exactGate('cachedListIdentityViolations', 0) lists it here.
const ID_VIOLATIONS_INFO =
  'per-frame dirtiness tracking — the live composite path never bumps cachedListIdentityViolations (only assertCleanIdentity does), so the lane reads 0 vacuously';
// §4.4.9 inputLagFrames is hardcoded `() => 0` in create-chart.ts (the host input-lag source is
// M11 wiring), so its ≤ 2 cap is satisfied vacuously (the value is always 0). Reported until M11.
const INPUT_LAG_INFO = 'host input-lag source — inputLagFrames is hardcoded () => 0 in create-chart.ts until M11 wires it';
export const INFORMATIONAL_UNTIL_M11: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  S2: {
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
    'inputLagFrames:exact': INPUT_LAG_INFO,
  },
  S2b: { 'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO },
  S3: {
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
    'inputLagFrames:exact': INPUT_LAG_INFO,
  },
  S8: {
    'drawCommands:max': '≤ 60 decimated cap needs the §6.3 emit-time decimation path',
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
  },
  S15: {
    'timelineRebuilds:exact':
      'data-work moves into applyRender — the lane is reset at frame entry while M9 does setData/update data-work synchronously before the frame, so it reads 0 vacuously',
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
  },
  S16: {
    'drawCommands:max': '≤ 220 cap needs price-line + marker scene-source emit',
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
  },
};
