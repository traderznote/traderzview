// M3 demo (roadmap §M3(e)) — builds fixture F0 (a rects run + a dashed polyline +
// a text item) via DisplayListBuilder, prints the resulting command stream and a
// crisp-function value table. Gated against scripts/demo-gfx.golden.txt. This
// hand-built list is reused as conformance fixture F0 at M6.
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const demoSource = `
import {
  DisplayListBuilder, LineStyle,
  crispWidth, crispStrokePos, tickRect, optimalBarWidth, optimalCandlestickWidth,
} from './src/gfx/index';

export function render() {
  const lines = [];
  const b = new DisplayListBuilder();
  b.beginList('bitmap');
  const r = b.rects({});
  r.quad(0, 0, 4, 10, '#26a69a');
  r.quad(6, 2, 4, 8, '#26a69a');
  r.quad(12, 1, 4, 9, '#ef5350');
  const p = b.polyline(1, LineStyle.Dashed, 'miter');
  p.vertex(0, 5, '#2196f3');
  p.vertex(8, 3, '#2196f3');
  p.vertex(16, 6, '#2196f3');
  b.beginList('media');
  b.text([{ x: 2, y: 12, text: 'O', font: { family: 'sans', size: 10 }, color: '#000' }]);
  const lists = b.finish();

  lines.push('F0 display list:');
  for (const dl of lists) {
    lines.push('  list space=' + dl.space + ' commands=' + dl.commands.length);
    for (const c of dl.commands) {
      if (c.kind === 'rects') {
        lines.push('    rects coords=[' + Array.from(c.coords).join(',') + '] runs=' + JSON.stringify(c.runs));
      } else if (c.kind === 'polyline') {
        lines.push('    polyline style=' + c.style + ' width=' + c.width + ' points=[' + Array.from(c.points).join(',') + '] runs=' + JSON.stringify(c.runs));
      } else if (c.kind === 'text') {
        lines.push('    text items=' + c.items.length + ' first="' + c.items[0].text + '"');
      }
    }
  }

  lines.push('');
  lines.push('crisp table:');
  lines.push('  crispWidth(1,2)=' + crispWidth(1, 2) + '  crispStrokePos(10,1,1)=' + crispStrokePos(10, 1, 1));
  lines.push('  tickRect(10,2,5)=' + JSON.stringify(tickRect(10, 2, 5)));
  lines.push('  optimalBarWidth(10,1)=' + optimalBarWidth(10, 1) + '  optimalCandlestickWidth(5,1)=' + optimalCandlestickWidth(5, 1));
  return lines;
}
`;

const dir = mkdtempSync(join(tmpdir(), 'tvdemo-'));
const out = join(dir, 'demo.mjs');
await build({
  stdin: { contents: demoSource, resolveDir: process.cwd(), loader: 'ts', sourcefile: 'demo-gfx.ts' },
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

const goldenPath = 'scripts/demo-gfx.golden.txt';
const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
if (!existsSync(goldenPath)) {
  writeFileSync(goldenPath, output + '\n');
  console.log('\ndemo-gfx: recorded baseline -> ' + goldenPath);
} else if (norm(output) !== norm(readFileSync(goldenPath, 'utf8'))) {
  console.error('\ndemo-gfx: STDOUT does not match ' + goldenPath);
  process.exit(1);
} else {
  console.log('\ndemo-gfx: output matches golden.');
}
