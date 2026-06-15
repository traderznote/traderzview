// bench/micro/microbench.mjs — the tinybench timing microbenches (perf §9.4, SOFT
// drift gates: warn 15% / fail 30%). Bundles cases.ts (the shipped hot-path bodies)
// from TS via esbuild — the goldens.mjs / conformance discipline (the §3.1 import
// wall keeps the bodies in core/data/model/views/gfx; this bench reaches into ../../src).
// __TV_PROFILE__=false: the counters strip out so we time the shipped math, not the
// instrumentation. Headless node (no browser, no tsc -b). The two EXACT goldens live
// in goldens.mjs; this file is the timing set — it reports a table and exits 0 (the
// drift gate against baselines runs in the Playwright/CI path, not here).
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Bench } from 'tinybench';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

// Bundle cases.ts once (its imports resolve against the repo root, like goldens.mjs).
const dir = mkdtempSync(join(tmpdir(), 'tvmicro-'));
const out = join(dir, 'cases.mjs');
await build({
  entryPoints: [join(here, 'cases.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  define: { __DEV__: 'false', __TV_PROFILE__: 'false' },
  logLevel: 'warning',
});
const { makeCases } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const cases = makeCases();

// tinybench (3.x): a short measured window per case (these are soft drift gates, not
// exact — a quick run surfaces a regression's order of magnitude). `warmup: true` runs
// the JIT in before timing (the §4.3 warm-up discipline, applied to node microbenches).
const bench = new Bench({ time: 200, warmupTime: 50, warmup: true, throws: true });
for (const c of cases) bench.add(c.name, c.fn);

let failed = 0;
try {
  await bench.run();
} catch (err) {
  // `throws: true` re-throws the first broken thunk — surface which case and fail.
  console.error(`micro: FAIL  a case threw during run\n    ${err?.message ?? err}`);
  failed++;
}

// Report the table (ops/s + mean ms). The committed §9.5 baselines.json drift gate is a
// CI concern (run.mjs); a smoke run just proves the bodies execute and prints the numbers.
const rows = bench.tasks.map((t) => ({
  name: t.name,
  'ops/s': t.result ? Math.round(t.result.hz) : 0,
  'mean ms': t.result ? Number(t.result.mean.toFixed(5)) : 0,
  samples: t.result ? (t.result.samples?.length ?? 0) : 0,
}));
console.table(rows);

// A case whose result is missing or carried an error never produced timing → broken body.
for (const t of bench.tasks) {
  if (!t.result || t.result.error) {
    console.error(`micro: FAIL  ${t.name}\n    ${t.result?.error?.message ?? 'no result'}`);
    failed++;
  }
}
if (failed > 0) {
  console.error(`\nmicro: ${bench.tasks.length - failed}/${bench.tasks.length} cases ran clean.`);
  process.exit(1);
}
console.log(`\nmicro: all ${bench.tasks.length} timing cases ran clean (soft drift gates, §9.4).`);
process.exit(0);
