// bench/scenarios/frametime-specs.ts — the FRAME-TIME scenario slice (perf §9.2 / §4.2):
// S1, S4–S7, S9–S11, S13, S14, S17, plus S12 (memory). Each S* file default-exports one
// ScenarioSpec carrying its §4.2 absolute frame-budget cap (a 'frame'-source p95/sum gate or
// a 'wallMs' scalar) and, where it is a steady-state path, its §5.3 alloc 'probe' gate; S12
// carries the §6.2 per-point byte-attribution 'probe' gates.
//
// These run under the THROTTLED PLAYWRIGHT runner (run.mjs, CI-gated, perf §4.3) — frame
// timings are runner-noise-sensitive, so they are NOT gated headless. The exception is S12,
// whose 'probe' deltas are also measurable as a NODE APPROXIMATION (node-mem.mjs: gc() +
// process.memoryUsage() bracketing the same setData steps — the §6.2 protocol over node's
// heap instead of CDP's), and the *shape* of every spec is node-smoke-checkable
// (well-formed gates, declared probe order) without a browser.
//
// This is the frame-time counterpart of structural-specs.ts's STRUCTURAL_SCENARIOS slice;
// the full §9.2 catalog (bench/scenarios.ts) is the source of truth run.mjs/driver consume.
// erasableSyntaxOnly: no enums; verbatimModuleSyntax: type-only imports split.
import type { ScenarioSpec } from '../gates';
import S1 from './S1';
import S4 from './S4';
import S5 from './S5';
import S6 from './S6';
import S7 from './S7';
import S9 from './S9';
import S10 from './S10';
import S11 from './S11';
import S12 from './S12';
import S13 from './S13';
import S14 from './S14';
import S17 from './S17';

/** The frame-time + memory scenario slice (perf §9.2 / §4.2 / §6.2). Ordered by id. */
export const FRAMETIME_SCENARIOS: readonly ScenarioSpec[] = [
  S1, S4, S5, S6, S7, S9, S10, S11, S12, S13, S14, S17,
];

/** S12 is the only slice member whose 'probe' gates have a headless node approximation
 *  (node-mem.mjs, §6.2). The frame-time members are Playwright-only (perf §4.3). */
export const NODE_MEMORY_SCENARIOS: readonly ScenarioSpec[] = [S12];
