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

// traderzview/extras subpath (design 02 §3.2). The whole-module bundle is built like E1
// (everything inlined) so it composes standalone.
await build({ ...shared, entryPoints: ['src/extras/index.ts'], outfile: 'dist/extras.mjs' }); // extras subpath

// Per-plugin increments (.size-limit.js "extras increments over E2"). A plugin's byte CAP
// is its MARGINAL cost when added to an app that already loaded the engine (createChart +
// gfx + core + fmt), NOT a standalone re-bundle of that shared infrastructure. So each
// plugin entry is bundled with the already-shipped engine module surfaces (gfx/core/fmt/
// api) marked EXTERNAL — what remains is the plugin's own code, which is what the increment
// measures. The four plugins import only api/gfx/core/fmt (the §3.1 wall; dep-cruiser E1).
const ENGINE_EXTERNAL = ['../../gfx', '../../core', '../../fmt', '../../api', '../shared'];
const pluginShared = { ...shared, external: ENGINE_EXTERNAL };
await build({ ...pluginShared, entryPoints: ['src/extras/markers/series-markers.ts'], outfile: 'dist/extras/series-markers.mjs' });
await build({ ...pluginShared, entryPoints: ['src/extras/markers/up-down-markers.ts'], outfile: 'dist/extras/up-down-markers.mjs' });
await build({ ...pluginShared, entryPoints: ['src/extras/watermark/text-watermark.ts'], outfile: 'dist/extras/text-watermark.mjs' });
await build({ ...pluginShared, entryPoints: ['src/extras/watermark/image-watermark.ts'], outfile: 'dist/extras/image-watermark.mjs' });

console.log('build: dist/index.mjs (E1), dist/gfx.mjs (E5), dist/extras.mjs + 4 per-plugin increments');
