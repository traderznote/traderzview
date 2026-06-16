// The union time pool (architecture §4.5, design 04 §6.2). One shared, sorted
// set of all series' time points; each slot is a dense integer TimeIndex. Storage
// is ARRAY-BACKED (a sorted Float64Array of HorzKeys + parallel TimeIndex
// Int32Array + Uint8Array weights + an originalTime/internal-item ref lane),
// looked up via the core lowerBound primitive — NEVER a Map (the 32 B/slot gate,
// design 04 §6.2). Whitespace items occupy a slot but yield no plot row.
//
// It also owns the off-grid key↔logical mapping (architecture §9.1 slot 2): the
// ONLY APIs that address positions where no data exists.
import { lowerBound, upperBound } from '../core';
import type { HorzKey, Logical, TimeIndex, IFrameCounters } from '../core';
import type { StoreDiff, TimelineDiff } from './diffs';
import type { HorzPoint, IHorzScaleBehavior } from './horz-behavior';

const ltNum = (a: number, b: number): boolean => a < b;
const gtNum = (a: number, b: number): boolean => a > b;

/** A non-whitespace plot row the caller feeds to a series' PlotStore. */
export interface PlotRow<TItem> {
  readonly item: TItem;
  readonly timeIndex: TimeIndex;
}

/** The result of merging one series' data into the union (architecture §4.5). */
export interface SeriesApplyResult<TItem> extends TimelineDiff {
  /** Non-whitespace rows, in ascending slot order, with their union TimeIndex. */
  readonly rows: readonly PlotRow<TItem>[];
}

/** The result of the equal-time / append fast path (study 02 §4.5). */
export interface FastPathResult<TItem> extends TimelineDiff {
  readonly store: StoreDiff;
  readonly timeIndex: TimeIndex;
  readonly row: PlotRow<TItem> | null; // null when the item is whitespace
}

interface SeriesEntry {
  keys: number[]; // this series' own sorted keys
  real: boolean[]; // parallel: true iff the item at that key is non-whitespace
}

interface ItemWithTime {
  time: unknown;
}

export class Timeline<TItem extends ItemWithTime = ItemWithTime, H = unknown, I = unknown> {
  readonly #behavior: IHorzScaleBehavior<H, I>;
  // union lanes (sorted by key) — the array-backed pool, design 04 §6.2.
  #keys = new Float64Array(0);
  #slotIndex = new Int32Array(0); // TimeIndex per slot (identity; held per the spec)
  #weights = new Uint8Array(0);
  #items: I[] = []; // representative internal item per slot (for fillWeights)
  #count = 0;
  // per-series own points, so the union can be rebuilt on re-apply.
  readonly #series = new Map<string, SeriesEntry>();
  // OR over series: how many series carry a REAL point at each slot.
  #realRefs: number[] = [];
  // The shared per-frame accumulator (perf §9.6). Set by the api under __TV_PROFILE__;
  // #rebuildUnion ++s timelineRebuilds (§4.4.4 — updateLast must leave it 0). Strips out.
  #counters: IFrameCounters | undefined;

  /** Wire the shared per-frame counters (perf §9.6; __TV_PROFILE__ only). */
  setCounters(counters: IFrameCounters): void {
    this.#counters = counters;
  }

  constructor(behavior: IHorzScaleBehavior<H, I>) {
    this.#behavior = behavior;
  }

  get slotCount(): number {
    return this.#count;
  }

  /** Merge one whole series' data into the union (replace-style; study 02 §4.2). */
  applySeriesData(seriesId: string, items: readonly TItem[], behavior: IHorzScaleBehavior<H, I>): SeriesApplyResult<TItem> {
    const convert = behavior.toInternal(items.map((it) => it.time as H));
    const keys: number[] = [];
    const real: boolean[] = [];
    const internalByKey = new Map<number, I>();
    for (const it of items) {
      const internal = convert(it.time as H);
      const k = behavior.key(internal as H | I) as unknown as number;
      keys.push(k);
      real.push(!this.#isWhitespace(it));
      internalByKey.set(k, internal);
    }
    this.#series.set(seriesId, { keys, real });

    const oldKeys = this.#keys;
    const oldCount = this.#count;
    this.#rebuildUnion(internalByKey);

    const firstChanged = this.#prefixDiff(oldKeys, oldCount);
    if (firstChanged !== null) this.#fillWeightsFrom(firstChanged);

    return {
      firstChanged: firstChanged === null ? null : (firstChanged as TimeIndex),
      baseIndex: this.#computeBaseIndex(),
      rows: this.#rowsFor(items, behavior),
    };
  }

  /**
   * The fast path for a single streaming `update()` (study 02): an equal last key
   * replaces the last bar with NO timeline work; a strictly-newer key that is
   * already a union slot appends; a brand-new key inserts (and shifts the union).
   */
  appendOrUpdateLast(seriesId: string, item: TItem, behavior: IHorzScaleBehavior<H, I>): FastPathResult<TItem> {
    const entry = this.#series.get(seriesId) ?? { keys: [], real: [] };
    const convert = behavior.toInternal([item.time as H]);
    const internal = convert(item.time as H);
    const k = behavior.key(internal as H | I) as unknown as number;
    const isReal = !this.#isWhitespace(item);
    const lastKey = entry.keys.length > 0 ? entry.keys[entry.keys.length - 1] : null;

    let store: StoreDiff;
    let prevReal = false;
    if (lastKey !== null && k === lastKey) {
      prevReal = entry.real[entry.real.length - 1];
      entry.real[entry.real.length - 1] = isReal;
      store = { kind: 'updateLast' };
    } else {
      entry.keys.push(k);
      entry.real.push(isReal);
    }
    this.#series.set(seriesId, entry);

    const slotPos = lowerBound(this.#keys, k, ltNum, 0, this.#count);
    const existed = slotPos < this.#count && this.#keys[slotPos] === k;

    let firstChanged: TimeIndex | null = null;
    if (lastKey === null || k !== lastKey) {
      if (existed) {
        // union geometry unchanged; this series now carries a (real?) point here.
        if (isReal) this.#realRefs[slotPos]++;
        store = { kind: 'append', count: 1 };
      } else {
        // a new union slot: rebuild + diff (insert shifts everything to its right).
        const oldKeys = this.#keys;
        const oldCount = this.#count;
        const internalByKey = new Map<number, I>([[k, internal]]);
        this.#rebuildUnion(internalByKey);
        const fc = this.#prefixDiff(oldKeys, oldCount);
        if (fc !== null) {
          this.#fillWeightsFrom(fc);
          firstChanged = fc as TimeIndex;
        }
        store = { kind: 'insert', atSlot: (firstChanged ?? (slotPos as TimeIndex)) };
      }
    } else {
      // equal-time last-bar replace: adjust this slot's real-reference count by the
      // whitespace↔real flip, no timeline work (the study 02 fast path).
      this.#realRefs[slotPos] += (isReal ? 1 : 0) - (prevReal ? 1 : 0);
      store = { kind: 'updateLast' };
    }

    const ti = lowerBound(this.#keys, k, ltNum, 0, this.#count) as TimeIndex;
    return {
      firstChanged,
      baseIndex: this.#computeBaseIndex(),
      store,
      timeIndex: ti,
      row: isReal ? { item, timeIndex: ti } : null,
    };
  }

  /** This series' rows' union TimeIndex slots, ascending (non-whitespace excluded). */
  timeIndicesFor(seriesId: string): number[] {
    const entry = this.#series.get(seriesId);
    if (entry === undefined) return [];
    const out: number[] = [];
    for (const k of entry.keys) {
      out.push(lowerBound(this.#keys, k, ltNum, 0, this.#count));
    }
    return out;
  }

  // --- off-grid key ↔ logical (architecture §9.1 slot 2) ------------------------

  /** key → fractional logical; null when <2 slots or (non-extrapolate) off the grid. */
  keyToLogical(key: HorzKey, opts?: { extrapolate?: boolean }): Logical | null {
    const n = this.#count;
    if (n < 2) return null;
    const k = key as unknown as number;
    const keys = this.#keys;
    if (k <= keys[0]) {
      if (k === keys[0]) return 0 as Logical;
      if (!opts?.extrapolate) return null;
      return (-(keys[0] - k) / this.#meanGap('left')) as Logical;
    }
    if (k >= keys[n - 1]) {
      if (k === keys[n - 1]) return (n - 1) as Logical;
      if (!opts?.extrapolate) return null;
      return (n - 1 + (k - keys[n - 1]) / this.#meanGap('right')) as Logical;
    }
    // interior: piecewise-linear between bracketing slots.
    const hi = lowerBound(keys, k, ltNum, 0, n); // first slot with key >= k
    if (keys[hi] === k) return hi as Logical;
    const lo = hi - 1;
    const frac = (k - keys[lo]) / (keys[hi] - keys[lo]);
    return (lo + frac) as Logical;
  }

  /** logical → key; null when <2 slots or (non-extrapolate) off the grid. */
  logicalToKey(logical: Logical, opts?: { extrapolate?: boolean }): HorzKey | null {
    const n = this.#count;
    if (n < 2) return null;
    const lg = logical as unknown as number;
    const keys = this.#keys;
    if (lg <= 0) {
      if (lg === 0) return keys[0] as unknown as HorzKey;
      if (!opts?.extrapolate) return null;
      return (keys[0] + lg * this.#meanGap('left')) as unknown as HorzKey;
    }
    if (lg >= n - 1) {
      if (lg === n - 1) return keys[n - 1] as unknown as HorzKey;
      if (!opts?.extrapolate) return null;
      return (keys[n - 1] + (lg - (n - 1)) * this.#meanGap('right')) as unknown as HorzKey;
    }
    const lo = Math.floor(lg);
    const frac = lg - lo;
    return (keys[lo] + frac * (keys[lo + 1] - keys[lo])) as unknown as HorzKey;
  }

  /** Real-slot keys whose slot index falls within a (fractional) logical range. */
  keysInRange(range: { from: Logical; to: Logical }): number[] {
    const n = this.#count;
    if (n === 0) return [];
    const from = Math.max(0, Math.ceil(range.from as unknown as number));
    const to = Math.min(n - 1, Math.floor(range.to as unknown as number));
    const out: number[] = [];
    for (let s = from; s <= to; s++) out.push(this.#keys[s]);
    return out;
  }

  /** FIXED nearest-slot search (architecture §13.14): total, clamps to the ends. */
  nearestSlotAt(key: HorzKey, dir: 'left' | 'right'): number {
    const n = this.#count;
    if (n === 0) return -1;
    const k = key as unknown as number;
    const pos = lowerBound(this.#keys, k, ltNum, 0, n);
    if (pos < n && this.#keys[pos] === k) return pos; // exact hit
    return dir === 'left' ? Math.max(0, pos - 1) : Math.min(pos, n - 1);
  }

  // --- internals ----------------------------------------------------------------

  #isWhitespace(item: TItem): boolean {
    // Whitespace = an item with no value-bearing field (design 02 §13.1). The
    // single-value and OHLC presence rule, expressed without the series contract
    // (the contract lives on the PlotStore; the timeline only needs slot occupancy).
    const o = item as unknown as { value?: unknown; open?: unknown };
    return o.value === undefined && o.open === undefined;
  }

  #rebuildUnion(internalByKey: Map<number, I>): void {
    // perf §9.6/§4.4.4: a full union rebuild (the path updateLast must avoid). Strips out.
    if (__TV_PROFILE__ && this.#counters !== undefined) this.#counters.timelineRebuilds++;
    // Merge every series' keys into one sorted, de-duplicated array.
    const set = new Set<number>();
    for (const entry of this.#series.values()) {
      for (const k of entry.keys) set.add(k);
    }
    const merged = [...set].sort((a, b) => a - b);
    const n = merged.length;

    // Preserve known internal items + weights for keys already present.
    const prevItem = new Map<number, I>();
    for (let s = 0; s < this.#count; s++) prevItem.set(this.#keys[s], this.#items[s]);

    const keys = new Float64Array(n);
    const slotIndex = new Int32Array(n);
    const items: I[] = new Array(n);
    const realRefs: number[] = new Array(n).fill(0);
    for (let s = 0; s < n; s++) {
      const k = merged[s];
      keys[s] = k;
      slotIndex[s] = s;
      const fromBatch = internalByKey.get(k);
      items[s] = fromBatch !== undefined ? fromBatch : (prevItem.get(k) as I);
    }
    // recompute the real-reference count per slot from every series.
    for (const entry of this.#series.values()) {
      for (let i = 0; i < entry.keys.length; i++) {
        if (!entry.real[i]) continue;
        const s = lowerBound(keys, entry.keys[i], ltNum, 0, n);
        realRefs[s]++;
      }
    }

    this.#keys = keys;
    this.#slotIndex = slotIndex;
    this.#items = items;
    this.#weights = new Uint8Array(n);
    this.#realRefs = realRefs;
    this.#count = n;
  }

  /** First slot whose key differs from the previous union (study 02 §4.3). */
  #prefixDiff(oldKeys: Float64Array, oldCount: number): TimeIndex | null {
    const n = this.#count;
    const min = Math.min(oldCount, n);
    for (let i = 0; i < min; i++) {
      if (oldKeys[i] !== this.#keys[i]) return i as TimeIndex;
    }
    if (oldCount !== n) return min as TimeIndex;
    return null;
  }

  #fillWeightsFrom(firstChanged: number): void {
    const n = this.#count;
    const points: HorzPoint<I>[] = new Array(n);
    for (let s = 0; s < n; s++) {
      points[s] = { item: this.#items[s], key: this.#keys[s] as unknown as HorzKey, weight: this.#weights[s] };
    }
    this.#behavior.fillWeights(points, firstChanged);
    for (let s = firstChanged; s < n; s++) this.#weights[s] = points[s].weight;
    if (firstChanged === 0 && n > 1) this.#weights[0] = points[0].weight; // first-point guess
  }

  #computeBaseIndex(): TimeIndex | null {
    for (let s = this.#count - 1; s >= 0; s--) {
      if (this.#realRefs[s] > 0) return s as TimeIndex;
    }
    return null;
  }

  #rowsFor(items: readonly TItem[], behavior: IHorzScaleBehavior<H, I>): PlotRow<TItem>[] {
    const convert = behavior.toInternal(items.map((it) => it.time as H));
    const rows: PlotRow<TItem>[] = [];
    for (const it of items) {
      if (this.#isWhitespace(it)) continue;
      const k = behavior.key(convert(it.time as H) as H | I) as unknown as number;
      const ti = lowerBound(this.#keys, k, ltNum, 0, this.#count) as TimeIndex;
      rows.push({ item: it, timeIndex: ti });
    }
    return rows;
  }

  /** Mean of the nearest up-to-10 gaps at the requested end (architecture §9.1). */
  #meanGap(end: 'left' | 'right'): number {
    const n = this.#count;
    const gaps = Math.min(10, n - 1);
    let sum = 0;
    if (end === 'left') {
      for (let s = 0; s < gaps; s++) sum += this.#keys[s + 1] - this.#keys[s];
    } else {
      for (let s = 0; s < gaps; s++) sum += this.#keys[n - 1 - s] - this.#keys[n - 2 - s];
    }
    return sum / gaps;
  }

  // referenced so noUnusedLocals does not flag the held identity lane / upperBound
  /** @internal slot → TimeIndex (identity lane, design 04 §6.2). */
  timeIndexOfSlot(slot: number): TimeIndex {
    return this.#slotIndex[slot] as TimeIndex;
  }

  /** @internal weight at a slot (consumed by the model's tick engine, M5). */
  weightAt(slot: number): number {
    return this.#weights[slot];
  }

  /** @internal the representative INTERNAL item at a slot — the `I` the behavior's
   *  formatTick/formatItem consume (the axis tick-label path). Undefined when out of
   *  range. Behavior-agnostic: callers feed it straight to behavior.formatTick, so a
   *  number-keyed behavior gets its number and the time behavior gets its {timestamp}. */
  internalAt(slot: number): I | undefined {
    return slot >= 0 && slot < this.#count ? this.#items[slot] : undefined;
  }

  /** @internal upper-bounded slot search (kept symmetric with nearestSlotAt). */
  firstSlotAfter(key: HorzKey): number {
    return upperBound(this.#keys, key as unknown as number, gtNum, 0, this.#count);
  }
}
