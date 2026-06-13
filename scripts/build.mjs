// Published-bundle build — dev-docs/design/01-architecture.md §3.2 and
// dev-docs/design/04-performance-strategy.md §3.3. ONE published bundle, dev-only
// code stripped via the __DEV__=false define; the __TV_PROFILE__ bench counters
// strip too (CI later asserts they cost 0 bytes). Size gates measure this output.
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const define = { __DEV__: 'false', __TV_PROFILE__: 'false' };
const shared = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  define,
  logLevel: 'warning',
};

rmSync('dist', { recursive: true, force: true });

// Only the entries that exist at the current milestone are built. E2 ({createChart}),
// E3 ({createChartWith}), and E4 (IIFE) activate once the api factory lands (M9+);
// their byte budgets are already committed in .size-limit.js as the contract.
await build({ ...shared, entryPoints: ['src/index.ts'], outfile: 'dist/index.mjs' }); // E1 (root)
await build({ ...shared, entryPoints: ['src/gfx/index.ts'], outfile: 'dist/gfx.mjs' }); // E5 (gfx subpath)

console.log('build: dist/index.mjs (E1), dist/gfx.mjs (E5)');
