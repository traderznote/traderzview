// M4 demo (roadmap §M4(e)) — builds a two-series union timeline, prints the
// StoreDiff/firstChanged sequence, the union slot count, and a keyToLogical table
// (exact slots + extrapolated off-grid points). Bundled from TS via esbuild and
// gated against scripts/demo-data.golden.txt (record-then-gate, like the others).
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demoSource = `
import { Timeline, timeBehavior } from './src/data/index';

export function render() {
  const lines = [];
  const b = timeBehavior();
  const tl = new Timeline(b);
  const r1 = tl.applySeriesData('a', [{ time: 1, value: 10 }, { time: 3, value: 30 }], b);
  lines.push('apply A (t=1,3): firstChanged=' + r1.firstChanged + ' baseIndex=' + r1.baseIndex + ' rows=' + r1.rows.length);
  const r2 = tl.applySeriesData('b', [{ time: 2, value: 20 }, { time: 4, value: 40 }], b);
  lines.push('apply B (t=2,4): firstChanged=' + r2.firstChanged + ' baseIndex=' + r2.baseIndex + ' rows=' + r2.rows.length);
  lines.push('union slotCount = ' + tl.slotCount);
  lines.push('keyToLogical (exact slots):');
  for (const k of [1, 2, 3, 4]) lines.push('  key ' + k + ' -> ' + tl.keyToLogical(k));
  lines.push('keyToLogical (extrapolated): key 0 -> ' + tl.keyToLogical(0, { extrapolate: true }) + ', key 6 -> ' + tl.keyToLogical(6, { extrapolate: true }));
  lines.push('logicalToKey 1.5 -> ' + tl.logicalToKey(1.5));
  return lines;
}
`;

const dir = mkdtempSync(join(tmpdir(), 'tvdemo-'));
const out = join(dir, 'demo.mjs');
await build({
  stdin: { contents: demoSource, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'demo-data.ts' },
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  define: { __DEV__: 'true', __TV_PROFILE__: 'false' },
  logLevel: 'warning',
});
const { render } = await import(pathToFileURL(out).href);
const output = render().join('\n');
rmSync(dir, { recursive: true, force: true });

console.log(output);

const goldenPath = 'scripts/demo-data.golden.txt';
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, output + '\n');
  console.log('\ndemo-data: recorded baseline -> ' + goldenPath);
} else if (norm(output) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-data: STDOUT does not match ' + goldenPath);
  process.exit(1);
} else {
  console.log('\ndemo-data: output matches golden.');
}
