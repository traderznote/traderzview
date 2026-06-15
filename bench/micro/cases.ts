// bench/micro/cases.ts — the timing-microbench bodies (perf §9.4), built from the
// SHIPPED source via esbuild (the goldens.mjs / conformance discipline; the §3.1
// import wall keeps these reaching into ../../src). Each `makeCases()` entry prepares
// its state ONCE (outside the measured thunk) and returns a zero-arg `fn` tinybench
// times. Soft drift gates only (warn 15% / fail 30%, §9.4) — never exact here; the
// two EXACT goldens (wheel + kinetic) live in goldens.mjs. __TV_PROFILE__=false so
// these measure the shipped math, counters stripped.
import { lowerBound, upperBound, mergeOptions } from '../../src/core/index';
import {
  reduceHorzCommands,
  buildHorzGeometry,
  buildPriceConverter,
  PriceScaleMode,
  TickMarkEngine,
  DEFAULT_CHART_OPTIONS,
} from '../../src/model/index';
import type { HorzScaleCommand, HorzGeometry, PriceConverter, ChartOptions } from '../../src/model/index';
import { PlotStore, singleValueContract, barContract } from '../../src/data/index';
import { createLineKind, createCandlestickKind, itemWindow, decimateColumns } from '../../src/views/index';
import type { ItemWindow } from '../../src/views/index';
import {
  DisplayListBuilder,
  crispWidth,
  crispRound,
  crispStrokePos,
  tickRect,
  optimalBarWidth,
  optimalCandlestickWidth,
  applyBarParity,
} from '../../src/gfx/index';
import type { ViewFrame } from '../../src/gfx/index';
import { mulberry32, SEED } from '../data-gen.mjs';

export interface MicroCase {
  readonly name: string;
  readonly fn: () => void;
}

// --- shared fixtures (built once; the thunks read them, never rebuild) -----------

/** A media-px ViewFrame for a 1600×900 DPR-2 surface (the R-scene geometry, §4.1). */
function viewFrame(hr: number, vr: number, w = 1600, h = 900): ViewFrame {
  return {
    frame: { mediaSize: { width: w, height: h }, bitmapSize: { width: w * hr, height: h * vr }, hr, vr },
    now: 0,
  };
}

/** Build a HorzGeometry at a given bar spacing over `n` bars (baseIndex = n−1). */
function horzAt(barSpacing: number, n: number, width = 1600): HorzGeometry {
  return buildHorzGeometry({ width, barSpacing, rightOffset: 0, baseIndex: n - 1 });
}

/** A normal-mode PriceConverter over [min,max] for a 900-px tall scale. */
function priceConv(min: number, max: number, height = 900): PriceConverter {
  return buildPriceConverter({
    height,
    range: { min, max },
    scaleMargins: { top: 0.1, bottom: 0.1 },
    marginAbovePx: 0,
    marginBelowPx: 0,
    mode: PriceScaleMode.Normal,
    inverted: false,
    firstValue: min,
  });
}

/** Fill a 1-lane (line/value) store with `n` seeded rows at integer times. */
function lineStore(n: number): PlotStore {
  const rng = mulberry32(SEED);
  const items: { value: number }[] = new Array(n);
  const times: number[] = new Array(n);
  let v = 100;
  for (let i = 0; i < n; i++) {
    v += (rng() - 0.5) * 2;
    items[i] = { value: v };
    times[i] = i;
  }
  const store = new PlotStore(singleValueContract);
  store.setData(items, times);
  return store;
}

/** Fill a 4-lane (OHLC) store with `n` seeded rows at integer times. */
function candleStore(n: number): PlotStore {
  const rng = mulberry32(SEED);
  const items: { open: number; high: number; low: number; close: number }[] = new Array(n);
  const times: number[] = new Array(n);
  let open = 100;
  for (let i = 0; i < n; i++) {
    const close = open + (rng() - 0.5) * 2;
    items[i] = { open, high: Math.max(open, close) + rng() * 1.5, low: Math.min(open, close) - rng() * 1.5, close };
    times[i] = i;
    open = close;
  }
  const store = new PlotStore(barContract);
  store.setData(items, times);
  return store;
}

export function makeCases(): MicroCase[] {
  const cases: MicroCase[] = [];

  // --- (1) lowerBound / upperBound over a 1 M-element sorted lane (§9.4) ----------
  {
    const N = 1_000_000;
    const lane = new Float64Array(N);
    for (let i = 0; i < N; i++) lane[i] = i; // ascending keys
    const lt = (a: number, b: number): boolean => a < b;
    const gt = (a: number, b: number): boolean => a > b;
    // A fixed sweep of 64 probe keys spanning the lane (deterministic work / call).
    const probes = new Float64Array(64);
    for (let i = 0; i < 64; i++) probes[i] = Math.floor((i / 64) * N) + 0.5;
    cases.push({
      name: 'lowerBound over 1M lane (64 probes)',
      fn: () => {
        let acc = 0;
        for (let i = 0; i < 64; i++) acc += lowerBound(lane, probes[i]!, lt);
        if (acc < 0) throw new Error('unreachable');
      },
    });
    cases.push({
      name: 'upperBound over 1M lane (64 probes)',
      fn: () => {
        let acc = 0;
        for (let i = 0; i < 64; i++) acc += upperBound(lane, probes[i]!, gt);
        if (acc < 0) throw new Error('unreachable');
      },
    });
  }

  // --- (2) mergeOptions over the full ChartOptions (§9.4) -------------------------
  {
    const base: ChartOptions = DEFAULT_CHART_OPTIONS;
    // A realistic patch: a nested layout/grid/crosshair change + a few leaves.
    const patch = {
      width: 1600,
      height: 900,
      layout: { textColor: '#cccccc', fontSize: 13, background: { color: '#101418' } },
      grid: { vertLines: { color: '#1e2530' }, horzLines: { visible: false } },
      crosshair: { mode: 'normal' as const },
    };
    cases.push({
      name: 'mergeOptions full ChartOptions',
      fn: () => {
        const out = mergeOptions(base, patch, DEFAULT_CHART_OPTIONS);
        if (out.width !== 1600) throw new Error('unreachable');
      },
    });
  }

  // --- (3) reduceHorzCommands law replay (§9.4) -----------------------------------
  {
    // A representative command stream exercising every law branch (replace / append /
    // animate-replace / stop). Built once; the thunk folds it left through the reducer.
    const stops = { kind: 'stopAnimation' } as HorzScaleCommand;
    const anim = { kind: 'animate', animation: { finished: () => true, positionAt: () => 0 } } as HorzScaleCommand;
    const stream: HorzScaleCommand[] = [
      { kind: 'setBarSpacing', value: 6 },
      { kind: 'setRightOffset', value: 3 },
      anim,
      { kind: 'setBarSpacing', value: 8 }, // cancels the pending animate
      anim, // re-appends an animate
      { kind: 'applyRange', range: { from: 0 as never, to: 100 as never } }, // REPLACE
      { kind: 'setBarSpacing', value: 12 },
      stops,
      { kind: 'fitContent' }, // REPLACE
      { kind: 'setRightOffset', value: 1 },
    ];
    cases.push({
      name: 'reduceHorzCommands law replay (10 cmds)',
      fn: () => {
        let q: readonly HorzScaleCommand[] = [];
        for (let i = 0; i < stream.length; i++) q = reduceHorzCommands(q, stream[i]!);
        if (q.length === 0) throw new Error('unreachable');
      },
    });
  }

  // --- (4) tick weight-merge build over 10 k marks (§9.4) -------------------------
  {
    const M = 10_000;
    const rng = mulberry32(SEED);
    // Weighted marks: a few high-weight (year/month) sparse, many low-weight dense —
    // the realistic significance distribution the greedy merge walks (study 03 §4.11).
    const marks: { index: number; weight: number }[] = new Array(M);
    for (let i = 0; i < M; i++) {
      const r = rng();
      const weight = r < 0.01 ? 5 : r < 0.05 ? 4 : r < 0.2 ? 3 : r < 0.5 ? 2 : 1;
      marks[i] = { index: i, weight };
    }
    const engine = new TickMarkEngine();
    engine.setMarks(marks);
    // Vary the key each call so the one-entry selection cache MISSES (measures the
    // greedy merge, not a cache hit — §4.11/§4.13). maxIndexesPerMark ∈ {8,9,...}.
    let tick = 0;
    cases.push({
      name: 'TickMarkEngine weight-merge (10k marks, cache-miss)',
      fn: () => {
        const sel = engine.build({ maxIndexesPerMark: 8 + (tick++ % 16) });
        if (sel.length === 0) throw new Error('unreachable');
      },
    });
  }

  // --- (5) chunked min/max scan (cached) vs cold full scan (§9.4) ------------------
  {
    const N = 100_000;
    const store = candleStore(N);
    // Cold: a full sequential min/max over the high/low lanes (what the chunk cache
    // REPLACES — the study 10 §4.3 baseline). We read raw lanes via the public view.
    cases.push({
      name: 'min/max COLD full scan (100k OHLC rows)',
      fn: () => {
        let mn = Infinity;
        let mx = -Infinity;
        for (let i = 0; i < N; i++) {
          const lo = store.min(i);
          const hi = store.max(i);
          if (lo < mn) mn = lo;
          if (hi > mx) mx = hi;
        }
        if (mn > mx) throw new Error('unreachable');
      },
    });
    // Cached: the chunked cache reduce (§4.3) — valueRange() folds ~3334 chunk extrema.
    cases.push({
      name: 'min/max CHUNKED cache reduce (100k OHLC rows)',
      fn: () => {
        const r = store.valueRange();
        if (r.min > r.max) throw new Error('unreachable');
      },
    });
  }

  // --- (6) per-kind convert + emit over a 10 k buffer (§9.4) -----------------------
  {
    const N = 10_000;
    // Line kind: store → buffer (itemsFromStore once), then convert+emit each call.
    const lstore = lineStore(N);
    const lkind = createLineKind({ color: '#2196f3', lineWidth: 2 });
    const lbuf = lkind.createBuffer();
    lkind.itemsFromStore(lstore, { kind: 'replace' }, lbuf);
    const lwin: ItemWindow = itemWindow(0, N);
    const lframe = viewFrame(2, 2);
    const lhorz = horzAt(3, N); // ≥1 px/bar → normal (non-decimated) path
    const lprice = priceConv(80, 120);
    const lout = new DisplayListBuilder();
    cases.push({
      name: 'line convert+emit (10k buffer)',
      fn: () => {
        lout.reset();
        lkind.convert(lbuf, lwin, lframe, lhorz, lprice);
        lkind.emit(lbuf, lwin, lframe, lout);
        const lists = lout.finish();
        if (lists.length === 0) throw new Error('unreachable');
      },
    });

    // Candlestick kind: same shape over the 4-lane OHLC buffer.
    const cstore = candleStore(N);
    const ckind = createCandlestickKind({ upColor: '#26a69a', downColor: '#ef5350' });
    const cbuf = ckind.createBuffer();
    ckind.itemsFromStore(cstore, { kind: 'replace' }, cbuf);
    const cwin: ItemWindow = itemWindow(0, N);
    const cframe = viewFrame(2, 2);
    const chorz = horzAt(6, N);
    const cprice = priceConv(80, 120);
    const cout = new DisplayListBuilder();
    cases.push({
      name: 'candlestick convert+emit (10k buffer)',
      fn: () => {
        cout.reset();
        ckind.convert(cbuf, cwin, cframe, chorz, cprice);
        ckind.emit(cbuf, cwin, cframe, cout);
        const lists = cout.finish();
        if (lists.length === 0) throw new Error('unreachable');
      },
    });
  }

  // --- (7) crisp* function batch (§9.4) -------------------------------------------
  {
    // A batch of every crisp primitive over a fixed sweep of coords/spacings — the
    // per-bar bitmap math an emit loop runs (study 05 §4.4 / study 06 §4.8).
    const coords = new Float64Array(256);
    for (let i = 0; i < 256; i++) coords[i] = i * 1.37 + 0.25;
    const ratio = 2;
    cases.push({
      name: 'crisp* batch (256 coords × 8 fns)',
      fn: () => {
        let acc = 0;
        for (let i = 0; i < 256; i++) {
          const c = coords[i]!;
          const bs = 1 + (i % 50) * 0.1;
          const w = crispWidth(bs, ratio);
          acc += crispRound(c, ratio);
          acc += crispStrokePos(c, ratio, w);
          acc += tickRect(c, ratio, 10).pos;
          acc += optimalBarWidth(bs, ratio);
          acc += optimalCandlestickWidth(bs, ratio);
          acc += applyBarParity(w, Math.max(1, Math.floor(ratio)));
        }
        if (acc === 0) throw new Error('unreachable');
      },
    });
  }

  // --- (8) decimation helper over 1 M lanes (§6.3 — the gate-of-record validate) --
  {
    // The §6.3 cost-model microbench: the column scan over 1 M sub-pixel rows. Spacing
    // is sub-pixel (barSpacing·hr < 1) so decimateColumns runs the active scan, emitting
    // O(deviceWidth) segments. This is the term §6.3 says must be validated before
    // baselines.json is committed (the dominant R2-frame cost).
    const N = 1_000_000;
    const store = lineStore(N);
    const win: ItemWindow = itemWindow(0, N);
    const hr = 2;
    const frame = viewFrame(hr, 2);
    const horz = horzAt(0.0003, N); // 0.0003 · 2 = 0.0006 < 1 → decimation ACTIVE
    const price = priceConv(80, 120);
    const out = new DisplayListBuilder();
    const opts = { shape: 'line' as const, color: '#2196f3', lineWidth: 2 };
    cases.push({
      name: 'decimateColumns over 1M lanes (line, sub-pixel)',
      fn: () => {
        out.reset();
        out.beginList('bitmap');
        const r = decimateColumns(store, win, frame, horz, price, out, opts);
        if (r === null) throw new Error('decimation INACTIVE — spacing not sub-pixel');
      },
    });
  }

  return cases;
}
