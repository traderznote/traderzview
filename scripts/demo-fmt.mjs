// M2 demo (roadmap §M2(e)) — formatted samples across precisions, the volume
// suffixes, percent, and date tokens. Bundled from the TS source via esbuild and
// gated against scripts/demo-fmt.golden.txt (record-then-gate, like demo-core).
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demoSource = `
import { priceFormatter, percentFormatter, volumeFormatter, formatDate, DEFAULT_DATE_FORMAT } from './src/fmt/index';

export function render() {
  const lines = [];
  lines.push('price (precision 2, minMove 0.01):');
  const p = priceFormatter(2, 0.01);
  for (const v of [1.5, -2.5, 1234.567, 0.999]) lines.push('  ' + v + ' -> ' + p.format(v));
  lines.push('price (precision 2, minMove 0.05 — snaps):');
  const p5 = priceFormatter(2, 0.05);
  for (const v of [1.23, 1.22]) lines.push('  ' + v + ' -> ' + p5.format(v));
  lines.push('percent (precision 2): 12.5 -> ' + percentFormatter(2, 0.01).format(12.5));
  lines.push('volume (precision 2):');
  const vol = volumeFormatter(2);
  for (const v of [500, 1500, 1234, 1500000, 2500000000]) lines.push('  ' + v + ' -> ' + vol.format(v));
  const d = new Date(Date.UTC(2026, 5, 14, 9, 7, 3));
  lines.push('date: ' + formatDate(d, DEFAULT_DATE_FORMAT, 'en-US') + ' | ' + formatDate(d, 'yyyy-MM-dd', 'en-US'));
  return lines;
}
`;

const dir = mkdtempSync(join(tmpdir(), 'tvdemo-'));
const out = join(dir, 'demo.mjs');
await build({
  stdin: { contents: demoSource, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'demo-fmt.ts' },
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

const goldenPath = 'scripts/demo-fmt.golden.txt';
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, output + '\n');
  console.log('\ndemo-fmt: recorded baseline -> ' + goldenPath);
} else if (norm(output) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-fmt: STDOUT does not match ' + goldenPath);
  process.exit(1);
} else {
  console.log('\ndemo-fmt: output matches golden.');
}
