// core/profiling.ts — the per-frame counter accumulator the lower layers write and
// the host reads (perf §9.6 instrumentation contract). Homed in `core` (the only
// module every producing layer may import, architecture §3.1) so data/model/views/
// backend can all `counters?.x++` without a forbidden import. Every field is a plain
// `+=` target; the whole interface and its writers compile out without __TV_PROFILE__
// (the same dead-code define as FrameStats, perf §3.3.1 — byte-verified to 0).
//
// Protocol (perf §9.6 counter-propagation contract): the host scheduler calls reset()
// at frame() entry, lower layers ONLY ++ their own lanes during the frame, and the
// host READS the lanes at endFrame() into one FrameStats. Write-during-frame /
// read-at-end, no contention — never read or reset from a producing layer.

/** The per-frame lanes the lower layers increment (perf §9.6). All counts/durations
 *  accumulate within ONE frame and are zeroed by `reset()` at frame entry. */
export interface IFrameCounters {
  // --- model / data layer ---
  /** Timeline rebuilds this frame (perf §4.4.4 — `updateLast` must leave this 0). */
  timelineRebuilds: number;
  /** Min/max chunks recomputed this frame (perf §4.4.4 — ≤ 1/series/tick on a live tick). */
  chunkRecomputes: number;
  // --- views / PaneScene layer ---
  /** Sources that rebuilt their display lists (dirty re-emit; perf §4.4.1/§4.4.2). */
  sourcesReEmitted: number;
  /** Sources that returned their cached list by identity (clean; perf §4.4.2). */
  sourcesCached: number;
  /** DisplayList objects composited this frame. */
  displayLists: number;
  /** DrawCommands emitted this frame across all surfaces (perf §4.4.3 — O(runs)). */
  drawCommands: number;
  /** Zero-tolerance: a clean source that returned a NON-identical array (perf §4.4.2). */
  cachedListIdentityViolations: number;
  // --- backend + views buffer layer ---
  /** Sum of renderLayer durations this frame, ms (perf §4.2 backend-share gate). */
  replayMs: number;
  /** ItemBuffer / DisplayListBuilder backing growths (perf §4.4.7 — 0 after warm-up). */
  bufferReallocs: number;
  /** Zero every lane. The scheduler calls this at frame() entry (perf §9.6 step 2). */
  reset(): void;
}

/** Concrete `IFrameCounters`. One per chart under __TV_PROFILE__; threaded to the
 *  data store, PaneScene, item buffers, and backend exactly as `perfSink` is. */
export class FrameCounters implements IFrameCounters {
  timelineRebuilds = 0;
  chunkRecomputes = 0;
  sourcesReEmitted = 0;
  sourcesCached = 0;
  displayLists = 0;
  drawCommands = 0;
  cachedListIdentityViolations = 0;
  replayMs = 0;
  bufferReallocs = 0;

  reset(): void {
    this.timelineRebuilds = 0;
    this.chunkRecomputes = 0;
    this.sourcesReEmitted = 0;
    this.sourcesCached = 0;
    this.displayLists = 0;
    this.drawCommands = 0;
    this.cachedListIdentityViolations = 0;
    this.replayMs = 0;
    this.bufferReallocs = 0;
  }
}

/** Construct a fresh zeroed per-frame accumulator (perf §9.6). */
export function createFrameCounters(): IFrameCounters {
  return new FrameCounters();
}
