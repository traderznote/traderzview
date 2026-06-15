// PROFILING-SYMBOLS-ARE-FREE gate — dev-docs/design/04-performance-strategy.md §3.3.1
// (the hard gate of §9.3) + §9.6 step 1. The __TV_PROFILE__ bench instrumentation must
// compile out to ZERO bytes in the shipped build: with the define false, every
// `if (__TV_PROFILE__) { … }` block, `__TV_PROFILE__ ? a : b` ternary, and the
// FrameStats/IPerfSink/IFrameCounters writers are dead code esbuild eliminates, so the
// published bundle is byte-identical whether or not the profiling lines exist.
//
// HOW THE GATE PROVES IT (the §3.3.1 "build with and without the define" comparison):
//   SHIPPED  = bundle the representative entry (E1 root — it pulls api→host→views→data→
//              core, exercising EVERY guard site) with define __TV_PROFILE__:false, minified.
//   CONTROL  = bundle the SAME entry, also __TV_PROFILE__:false, but through an esbuild
//              onLoad plugin that PHYSICALLY removes the profiling source (the guard blocks
//              and ternaries) before esbuild sees it — i.e. the bundle "without the lines".
//   ASSERT   = SHIPPED bytes === CONTROL bytes. If any guarded line survived DCE, the two
//              differ. A second assertion: the shipped bundle contains NONE of the
//              profiling-only property names (no property mangler, §3.2.5, so they would
//              survive if any profiling code remained), catching a leak the byte diff can't
//              localize. Headless node + esbuild; no browser (perf §9.1).
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const ENTRY = 'src/index.ts'; // E1 root — exercises every __TV_PROFILE__ guard site
const DEFINE = { __DEV__: 'false', __TV_PROFILE__: 'false' };
// minifyWhitespace + minifySyntax (the byte-shrinking + DCE passes) but NOT
// minifyIdentifiers: esbuild's local-name mangler assigns single-letter names off an
// internal counter, so the stripped CONTROL source — a few bytes shorter upstream —
// gets a DIFFERENT name allocation than the SHIPPED build even when the two are
// semantically identical. That is a mangler artifact, not a profiling byte. Disabling
// identifier mangling makes the comparison deterministic: any surviving difference is
// real profiling code. Whitespace + syntax (incl. dead-code elimination) are still
// fully applied, so the gate still measures the SHIPPED DCE behavior.
const SHARED = {
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minifyWhitespace: true,
  minifySyntax: true,
  minifyIdentifiers: false,
  legalComments: 'none',
  write: false,
  logLevel: 'warning',
};

// Profiling-ONLY property names (no rename mangler, §3.2.5 — they survive identifier
// minification if any profiling code remains). Sentinels that COLLIDE with always-shipped
// names are deliberately excluded: `sourcesReEmitted` is PaneScene's own always-on field and
// `displayLists` is the always-on SceneSource method (`e.source.displayLists()`), so neither
// can distinguish a profiling leak; `onFrame` is a substring of requestAnimationFrame. By
// contrast `sourcesCached` and `drawCommands` appear ONLY inside profiling code (the
// IFrameCounters lanes, guarded by __TV_PROFILE__), so they ARE unique profiling sentinels.
// These ten are unique to the profiling surface (the IFrameCounters lanes + the
// createFrameCounters/FrameCounters/IFrameCounters symbols).
const PROFILING_NAMES = [
  'timelineRebuilds',
  'chunkRecomputes',
  'cachedListIdentityViolations',
  'bufferReallocs',
  'inputLagFrames',
  'replayMs',
  'sourcesCached', // profiling-unique lane (NOT an always-on field) — strengthens the no-leak check (fix #4a)
  'createFrameCounters',
  'FrameCounters',
  'IFrameCounters',
];

/**
 * Strip the __TV_PROFILE__ profiling source from a TS file's text (the CONTROL bundle —
 * the build "without the lines"). Handles exactly the three guard FORMS this codebase
 * uses, mirroring what esbuild's DCE does when the define is false:
 *   1. `if (__TV_PROFILE__ …) { …balanced braces… }`  → removed entirely
 *   2. `if (__TV_PROFILE__ …) singleStatement;`        → removed (the to-EOL form)
 *   3. `__TV_PROFILE__ ? A : B`                         → replaced with `B`
 * (type-only imports of FrameStats/IPerfSink/FrameProfiler are erased by esbuild's
 * verbatimModuleSyntax regardless, so they need no stripping.)
 */
function stripProfiling(src) {
  let out = src;
  // Form 3 first (the ternary `__TV_PROFILE__ ? A : B`): fold to B, esbuild's `false?A:B`.
  // Non-greedy A and B up to the statement-ending `)` or `;` / `,`. The THREE uses in this
  // codebase are `__TV_PROFILE__ ? deps.profiler : undefined` and
  // `__TV_PROFILE__ ? this.#deps.profiler : undefined` (both in host/chart-host.ts) and
  // `__TV_PROFILE__ ? profiler : undefined` (the buildHost call in api/create-chart.ts) —
  // fold each to `undefined`.
  out = out.replace(/__TV_PROFILE__\s*\?[^:]+:\s*([A-Za-z0-9_.#]+)/g, '$1');

  // Forms 1 & 2: scan for `if (__TV_PROFILE__` and remove the whole statement.
  let i;
  while ((i = out.indexOf('if (__TV_PROFILE__')) !== -1) {
    // Find the end of the condition: the matching ')' of the `if (`.
    let depth = 0;
    let j = i + 3; // at the '(' of `if (`
    for (; j < out.length; j++) {
      const ch = out[j];
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) break;
      }
    }
    // j is at the condition's closing ')'. Skip whitespace to the statement body.
    let k = j + 1;
    while (k < out.length && /\s/.test(out[k])) k++;
    let end;
    if (out[k] === '{') {
      // Form 1: balanced-brace block. Walk to the matching '}'.
      let bdepth = 0;
      for (; k < out.length; k++) {
        const ch = out[k];
        if (ch === '{') bdepth++;
        else if (ch === '}') {
          bdepth--;
          if (bdepth === 0) {
            end = k + 1;
            break;
          }
        }
      }
    } else {
      // Form 2: single statement to the next ';'.
      end = out.indexOf(';', k) + 1;
    }
    out = out.slice(0, i) + out.slice(end);
  }
  return out;
}

const stripPlugin = {
  name: 'strip-profiling',
  setup(b) {
    b.onLoad({ filter: /\.ts$/ }, (args) => {
      const src = readFileSync(args.path, 'utf8');
      return { contents: stripProfiling(src), loader: 'ts' };
    });
  },
};

const shipped = await build({ ...SHARED, entryPoints: [ENTRY], define: DEFINE });
const control = await build({ ...SHARED, entryPoints: [ENTRY], define: DEFINE, plugins: [stripPlugin] });

const shippedBytes = shipped.outputFiles[0].contents;
const controlBytes = control.outputFiles[0].contents;
const shippedText = Buffer.from(shippedBytes).toString('utf8');

let failed = false;

// Assertion 1: byte-identity (the §3.3.1 "with and without the define" comparison).
const sameLength = shippedBytes.length === controlBytes.length;
let firstDiff = -1;
if (sameLength) {
  for (let i = 0; i < shippedBytes.length; i++) {
    if (shippedBytes[i] !== controlBytes[i]) {
      firstDiff = i;
      break;
    }
  }
}
const byteIdentical = sameLength && firstDiff === -1;
console.log(`profiling-free: shipped=${shippedBytes.length}B control=${controlBytes.length}B`);
if (byteIdentical) {
  console.log('profiling-free: byte-identical — profiling code DCEs to 0 bytes (§3.3.1). ✓');
} else {
  failed = true;
  console.error(
    sameLength
      ? `profiling-free: FAIL — same length but bytes differ at offset ${firstDiff}.`
      : `profiling-free: FAIL — length differs (${shippedBytes.length} vs ${controlBytes.length}); profiling code did NOT strip.`,
  );
}

// Assertion 2: no profiling-only identifier survives in the shipped bundle.
const leaked = PROFILING_NAMES.filter((n) => shippedText.includes(n));
if (leaked.length === 0) {
  console.log('profiling-free: shipped bundle contains no profiling identifiers. ✓');
} else {
  failed = true;
  console.error(`profiling-free: FAIL — profiling identifiers leaked into the shipped bundle: ${leaked.join(', ')}`);
}

if (failed) process.exit(1);
console.log('\nprofiling-free: PASS (perf §3.3.1 — profiling symbols are free).');
