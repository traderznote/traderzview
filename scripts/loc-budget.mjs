// LOC budget gate — dev-docs/design/01-architecture.md §11. Counts all .ts lines
// (incl. comments & blanks; *.test.ts / *.spec.ts excluded) per module and fails
// if any module exceeds its loc-budget.json limit. Also asserts that the derived
// `total` equals the sum of the per-module budgets.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, 'src');
const { budgets, total } = JSON.parse(readFileSync(join(root, 'loc-budget.json'), 'utf8'));

const isCountable = (name) =>
  name.endsWith('.ts') && !name.endsWith('.test.ts') && !name.endsWith('.spec.ts') && !name.endsWith('.d.ts');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (isCountable(name)) out.push(p);
  }
  return out;
}

function countLines(file) {
  const text = readFileSync(file, 'utf8');
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop(); // drop final newline's empty tail
  return lines.length;
}

// `entries` = top-level .ts files directly under src/ (e.g. src/index.ts).
// Every other key = the same-named directory under src/.
function filesFor(key) {
  if (key === 'entries') {
    return readdirSync(srcDir)
      .filter(isCountable)
      .map((n) => join(srcDir, n))
      .filter((p) => statSync(p).isFile());
  }
  const dir = join(srcDir, key);
  try {
    if (!statSync(dir).isDirectory()) return [];
  } catch {
    return [];
  }
  return walk(dir);
}

let failed = false;
let measuredTotal = 0;
let budgetTotal = 0;
const rows = [];
for (const [key, budget] of Object.entries(budgets)) {
  const loc = filesFor(key).reduce((n, f) => n + countLines(f), 0);
  measuredTotal += loc;
  budgetTotal += budget;
  const ok = loc <= budget;
  if (!ok) failed = true;
  rows.push({ key, loc, budget, ok });
}

if (budgetTotal !== total) {
  console.error(`loc-budget.json: total ${total} != sum(budgets) ${budgetTotal}`);
  failed = true;
}

const padR = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);
console.log('LOC budgets (architecture §11)\n');
console.log(`${padR('module', 16)} ${padL('loc', 7)} ${padL('budget', 8)}  status`);
console.log('-'.repeat(46));
for (const r of rows) console.log(`${padR(r.key, 16)} ${padL(r.loc, 7)} ${padL(r.budget, 8)}  ${r.ok ? 'ok' : 'OVER'}`);
console.log('-'.repeat(46));
console.log(`${padR('TOTAL', 16)} ${padL(measuredTotal, 7)} ${padL(budgetTotal, 8)}  (limit derived)`);

if (failed) {
  console.error('\nLOC budget check FAILED.');
  process.exit(1);
}
console.log('\nLOC budget check passed.');
