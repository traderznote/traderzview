// host/profiling.ts — the per-frame stats one chart emits to its IPerfSink (perf §9.6).
// One FrameStats per painted frame: the host-timed *Ms brackets + the resolved level +
// inputLagFrames, fused with the IFrameCounters lanes the host READS at endFrame (the
// lower layers ++ them during the frame; the scheduler reset() them at entry). The whole
// surface compiles out without __TV_PROFILE__ (perf §3.3.1, byte-verified to 0 bytes).
import type { UpdateLevel } from '../model';

/** One painted frame's profile (perf §9.6). `*Ms` are host `performance.now()` brackets
 *  (§4.3); the count lanes are copied from the IFrameCounters accumulator at endFrame. */
export interface FrameStats {
  level: UpdateLevel;
  totalMs: number; // frame() entry → paint complete
  layoutMs: number; // Layout phase (0 unless level === Layout)
  modelMs: number; // autoscale + horz commands + axis models
  emitMs: number; // dirty sources: update() + displayLists() rebuild
  replayMs: number; // sum of renderLayer durations this frame
  sourcesUpdated: number; // update() calls issued
  sourcesReEmitted: number; // sources that rebuilt lists (dirty)
  sourcesCached: number; // sources that returned cached lists (identity-checked)
  displayLists: number;
  drawCommands: number;
  bufferReallocs: number; // ItemBuffer/DisplayListBuilder backing growths
  timelineRebuilds: number; // §4.4.4
  chunkRecomputes: number; // min/max chunks recomputed
  cachedListIdentityViolations: number; // §4.4.2 zero-tolerance
  inputLagFrames: number; // max rAF periods input-arrival → this paint (§4.4.9); 0 if none
}

/** The bench sink the host calls once per painted frame (perf §9.6). */
export interface IPerfSink {
  onFrame(stats: FrameStats): void;
}
