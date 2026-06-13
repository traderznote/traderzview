// tinybench placeholder — proves the microbench runner wiring. Real microbenches
// (crisp* math, lowerBound, kinetic decay) land from M10 (perf §9.4). Never gated.
import { Bench } from 'tinybench';

const bench = new Bench({ time: 50 });
bench.add('noop', () => {});
await bench.run();
console.table(bench.table());
