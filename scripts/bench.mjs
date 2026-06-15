// `bench` CI job (roadmap §M10) — the NODE-gated bench gates that run on every PR (perf §9.1):
// the structural counter-propagation checks, the §4.4 structural-invariant scenario slice
// (S2/S2b/S3/S8/S15/S16), the frame-time slice AUTHORING shape-check (S1/S4-S7/S9-S11/S13/S14/
// S17 — their §4.2 caps + drift baselines are asserted here; the TIMINGS run only under the
// CI-gated Playwright runner, perf §4.3), the S12 §6.2 memory NODE approximation, and the EXACT
// wheel+kinetic microbench goldens. All headless — they read frameCounters off a stub-backend
// chart with __TV_PROFILE__=true (no browser). The Playwright frame-time runner (bench/run.mjs)
// is CI-gated separately (perf §4.3) and NOT run here. Run from the repo root so the harness's
// ./src bundle resolves (perf §9.1 convention).
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gates = [
  ['structural', join('bench', 'structural.mjs')], // counter-propagation + §4.4 mechanism checks
  ['scenarios-structural', join('bench', 'scenarios', 'structural.mjs')], // S2/S2b/S3/S8/S15/S16
  // S1/S4-S7/S9-S11/S13/S14/S17 frame-time slice: AUTHORING shape-check (the timing gates run
  // only under the CI-gated Playwright runner, perf §4.3 — here we assert the §4.2 caps + drift
  // baselines are declared correctly and every script runs headless without throwing).
  ['scenarios-frametime', join('bench', 'scenarios', 'frametime-smoke.mjs')],
  // S12 memory: the §6.2 per-point byte-attribution NODE approximation (needs --expose-gc for
  // the gc()/process.memoryUsage() heap-floor bridge; the absolute budget is gated by run.mjs).
  ['scenarios-mem', join('bench', 'scenarios', 'node-mem.mjs'), ['--expose-gc']],
  ['goldens', join('bench', 'micro', 'goldens.mjs')], // EXACT wheel + kinetic golden gate
  // The Playwright frame-time runner (roadmap §M10(e): `bench/run.mjs` IS the CI bench job).
  // It is CI-gated — it launches throttled headless Chromium for the §4.2/§4.3 TIMING gates,
  // and self-skips with exit 0 when Chromium is absent (perf §9.1). So including it here keeps
  // `pnpm run bench` green headlessly while the CI runner with Chromium gates the real timings.
  ['frametime-playwright', join('bench', 'run.mjs')],
];

let failed = 0;
for (const [name, script, nodeArgs = []] of gates) {
  console.log(`\nbench: === ${name} (${script}) ===`);
  const r = spawnSync(process.execPath, [...nodeArgs, script], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`bench: ${name} FAILED (exit ${r.status}).`);
    failed++;
  }
}

console.log(`\nbench: ${gates.length - failed}/${gates.length} node gate group(s) passed.`);
process.exit(failed > 0 ? 1 : 0);
