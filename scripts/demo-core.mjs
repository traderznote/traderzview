// M1 demo (roadmap §M1(e)) — a worked mergeOptions (with a null leaf-reset) and a
// lowerBound/upperBound table, bundled from the TS source via esbuild and run. On
// first run it records scripts/demo-core.golden.txt; thereafter it gates stdout
// against that baseline (the record-then-gate pattern the conformance suite uses).
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Demo source (kept as a string so the script has no separate .ts entry). No
// backticks / ${} inside — it lives in this template literal.
const demoSource = `
import { mergeOptions, lowerBound, upperBound } from './src/core/index';

export function render() {
  const lines = [];
  const base = { color: 'red', grid: { visible: true, width: 2 } };
  const defaults = { color: 'black', grid: { visible: true, width: 1 } };
  const patch = { color: null, grid: { width: 4 } };
  lines.push('mergeOptions (null resets color to default; grid.width patched):');
  lines.push('  base    = ' + JSON.stringify(base));
  lines.push('  patch   = ' + JSON.stringify(patch));
  lines.push('  default = ' + JSON.stringify(defaults));
  lines.push('  result  = ' + JSON.stringify(mergeOptions(base, patch, defaults)));
  lines.push('');
  const arr = [10, 20, 20, 30];
  const lt = (a, v) => a < v;
  const gt = (a, v) => a > v;
  lines.push('bounds over arr = ' + JSON.stringify(arr) + ':');
  for (const v of [5, 20, 25, 30, 40]) {
    lines.push('  v=' + v + ': lowerBound=' + lowerBound(arr, v, lt) + ' upperBound=' + upperBound(arr, v, gt));
  }
  return lines;
}
`;

const dir = mkdtempSync(join(tmpdir(), 'tvdemo-'));
const out = join(dir, 'demo.mjs');
await build({
  stdin: { contents: demoSource, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'demo-core.ts' },
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

const goldenPath = 'scripts/demo-core.golden.txt';
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, output + '\n');
  console.log('\ndemo-core: recorded baseline -> ' + goldenPath);
} else if (norm(output) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-core: STDOUT does not match ' + goldenPath);
  process.exit(1);
} else {
  console.log('\ndemo-core: output matches golden.');
}
