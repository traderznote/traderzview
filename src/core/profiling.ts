// Bench-counter shapes (perf §9.6). Behind __TV_PROFILE__ and fleshed out in M10;
// present now only as a type so every producing layer can import it without a
// later breaking change. The runtime counters (replayMs, allocation tallies,
// frame timings) are added when the bench harness lands.
export interface IFrameCounters {
  // Intentionally empty at M1 — see perf §9.6 (M10 fills this in).
  readonly _placeholder?: never;
}
