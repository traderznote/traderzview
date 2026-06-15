// bench/scenarios/node-adapter.mjs — the HEADLESS BenchChart adapter the node structural
// runner drives (perf §9.6). It builds a scene fixture (scenes.mjs, stub backend,
// __TV_PROFILE__=true) and wraps it in the abstract BenchChart the ScenarioSpec scripts
// drive — the node counterpart of bench/browser/driver.ts's `adapt()` (which drives a REAL
// canvas chart). Both honor the same BenchChart surface so the SAME scenario scripts run in
// either place; only the backend + how a frame is driven differ.
//
// HEADLESS FRAME MODEL (what each BenchChart call maps to over the stub backend):
//   crosshairMove(x,y) → chart.setCrosshairPosition(price, time, series) → UpdateLevel.Overlay,
//                        then flush the one armed frame. An Overlay frame composites bands 6–8
//                        ONLY (pane-scene.ts #orderedEntries), so base series sources are never
//                        visited — that is the §4.4.1 zero-base-re-emit mechanism the gates read.
//   update(i,pt)       → series[i].update(pt) (no flush — appends coalesce into the pending mask
//                        until frame(), the §4.4.5 single-frame-per-turn discipline).
//   setData(i,data)    → series[i].setData(data) (no flush).
//   frame()            → flush the one pending rAF → one painted FrameStats (or a no-op if the
//                        turn armed nothing, e.g. an idle frame() after a coalesced burst).
//   pan(dxBars)        → a Render-level frame PROXY. The headless time-scale port's
//                        scrollToPosition is a no-op (create-chart.ts) — the real pan path runs
//                        through the host input pipeline (hooks.pan → invalidate(Render)), which
//                        a stub backend has no pointer stream to drive. So a node `pan` issues a
//                        faithful Render frame the way structural.mjs already does: an in-place
//                        updateLast on series 0 (same last time → no timeline rebuild, §4.4.4)
//                        which dirties that source → a Render re-composite. The §4.4.2/§4.4.3
//                        COUNTS a pan exercises (clean sources re-emit by identity; O(runs)
//                        command stream) are what the structural gates read, and they are
//                        identical whether the Render frame was provoked by a scroll or an
//                        append — the browser runner (run.mjs) drives the real scroll for the
//                        TIMING gates. Documented substitution; same spirit as scenes.mjs's
//                        area→line node stand-in.
//   wheel(x,y,dy)      → a Render-level frame proxy, same realization as pan (a wheel zoom is a
//                        Render invalidate headless; the EXACT wheel-normalization math is gated
//                        by the micro/goldens.mjs golden, not by these structural counters).
//
// makeNodeBenchChart(sceneFixture) returns { chart, fixture, frameSnaps } where `chart` is the
// BenchChart and `frameSnaps` is one IFrameCounters-shaped snapshot per painted frame (the live
// counters copied at flush time — so a gate can assert an EXACT per-frame ceiling the way
// run.mjs's reduceFrame does over the FrameStats stream).
import { SCENES } from '../scenes.mjs';

// Snapshot one painted frame's lanes into a plain FrameStats-shaped object the gates read.
// The count lanes come from the just-flushed FrameStats (the host's endFrame read of the live
// counters — perf §9.6 step 4); inputLagFrames rides the FrameStats too. This mirrors run.mjs's
// per-frame FrameStats stream so the SAME gate metric keys (drawCommands, inputLagFrames,
// cachedListIdentityViolations, timelineRebuilds …) reduce identically headless and in-browser.
function snapFrame(stats) {
  return {
    level: stats.level,
    drawCommands: stats.drawCommands,
    displayLists: stats.displayLists,
    sourcesReEmitted: stats.sourcesReEmitted,
    sourcesCached: stats.sourcesCached,
    sourcesUpdated: stats.sourcesUpdated,
    cachedListIdentityViolations: stats.cachedListIdentityViolations,
    timelineRebuilds: stats.timelineRebuilds,
    chunkRecomputes: stats.chunkRecomputes,
    bufferReallocs: stats.bufferReallocs,
    inputLagFrames: stats.inputLagFrames,
    replayMs: stats.replayMs,
  };
}

/**
 * Build the BenchChart adapter over a scene fixture (one of scenes.mjs's R0–R6 results).
 * `frameSnaps` collects the live counter state at each FLUSHED frame; the `frames`
 * (FrameStats[]) the IPerfSink already collected are on the fixture.
 */
export function makeNodeBenchChart(fixture) {
  const { chart, raf, series, scene } = fixture;
  const frameSnaps = []; // one snapFrame() per ACTUAL painted frame (the §4.4 gate stream)
  let now = 1000;
  let overlayLevel; // the resolved UpdateLevel value of an Overlay frame (learned at runtime)

  // Flush exactly the one pending frame the model armed (if any) and snapshot the FrameStats the
  // host emitted for it. A turn that armed nothing (idle) records nothing — the §4.4.5 coalescing
  // gate counts ACTUAL painted frames, so a no-op flush must not fake one.
  const flush = () => {
    const before = fixture.frames.length;
    if (!raf.hasPending()) return false;
    raf.flush(now++);
    if (fixture.frames.length > before) {
      frameSnaps.push(snapFrame(fixture.frames[fixture.frames.length - 1]));
      return true;
    }
    return false;
  };

  // Resolve a horizontal item (Time) for setCrosshairPosition: the integer index data-gen uses.
  // The scene's series carry { time: i, ... }; a crosshair lands on a real bar's time.
  const someSeries = series && series.length > 0 ? series[0] : null;
  const lastTime = () => {
    if (someSeries === null) return 0;
    const d = someSeries.data();
    const last = d.length > 0 ? d[d.length - 1] : null;
    return last && typeof last.time === 'number' ? last.time : 0;
  };

  const benchChart = {
    setData(i, data) {
      const s = series && series[i];
      if (s) s.setData(data);
    },
    update(i, point) {
      const s = series && series[i];
      if (s) s.update(point);
    },
    async crosshairMove(x, _y) {
      // Overlay invalidate via the §7 sync seam (setCrosshairPosition). Land on a real bar
      // time so the crosshair source has geometry; price drives the lazy payload (S2b).
      const t = (lastTime() - (Math.round(x) % 64) + 64) % Math.max(1, lastTime() || 1);
      const before = frameSnaps.length;
      chart.setCrosshairPosition(null, t, someSeries ?? undefined);
      const painted = flush();
      // The first crosshair-provoked painted frame tells us the resolved Overlay level value
      // (the host stamped it on FrameStats.level). Crosshair is the only Overlay-invalidating
      // call the structural scripts make, so its frames define the Overlay set for this run.
      if (painted && overlayLevel === undefined && frameSnaps.length > before) {
        overlayLevel = frameSnaps[frameSnaps.length - 1].level;
      }
    },
    async wheel(_x, _y, _deltaY) {
      // Render-frame proxy (see header). fitContent is the public Render-invalidating nav call.
      chart.timeScale().fitContent();
      flush();
    },
    async pan(_dxBars) {
      // Render-frame proxy (see header): an in-place updateLast on series 0 → dirty source →
      // Render re-composite. Same-time keeps timelineRebuilds 0 (§4.4.4).
      if (someSeries !== null) {
        const t = lastTime();
        const d = someSeries.data();
        const last = d.length > 0 ? d[d.length - 1] : null;
        const v = last && typeof last.value === 'number' ? last.value : 100;
        someSeries.update({ time: t, value: v });
      }
      flush();
    },
    async frame() {
      flush();
    },
  };

  return {
    chart: benchChart,
    fixture,
    frameSnaps, // one snapFrame() per painted frame (the §4.4 gate stream)
    scene,
    realChart: chart, // the underlying IChart (the runner's harness attaches the S2b listener)
    // Frames whose resolved level is Overlay (S2/S2b/S16 base-only invariant reads these). Empty
    // until a crosshairMove painted at least one frame (the level is learned at runtime).
    overlayFrames: () => (overlayLevel === undefined ? [] : frameSnaps.filter((s) => s.level === overlayLevel)),
  };
}

/** Build a scene fixture by id (R1/R2/R6 …) — the structural runner's scene factory. */
export async function buildScene(sceneId) {
  const builder = SCENES[sceneId];
  if (builder === undefined) throw new Error(`unknown scene ${sceneId}`);
  return builder();
}

// (The structural runner builds scenes at headless sizes directly via scenes.mjs; this id-keyed
// factory stays for any scene-agnostic caller that wants the §4.1 defaults.)
