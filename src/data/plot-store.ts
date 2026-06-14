// Columnar per-series plot storage (architecture §4.5). Structure-of-arrays:
// one Float64Array lane per data column (1 for single-value kinds — halves memory
// — 4 for OHLC), a parallel TimeIndex lane, and a chunked min/max cache for
// autoscale (study 10 §4.3). Readers go through role accessors and never branch on
// lane count. PlotStoreView is the read-only face (re-exported to indicators, §9.2).
import { lowerBound } from '../core';
import type { TimeIndex } from '../core';
import type { StoreDiff } from './diffs';
import type { SeriesDataContract } from './series-contract';

const CHUNK = 30;
const lt = (a: number, b: number): boolean => a < b;

export interface PlotStoreView {
  readonly length: number;
  timeIndex(i: number): TimeIndex;
  current(i: number): number; // role accessor: close / value
  min(i: number): number; // role accessor: low / value
  max(i: number): number; // role accessor: high / value
  lane(n: number, i: number): number; // raw lane n (n < contract.laneCount)
  firstIndexAt(timeIndex: TimeIndex): number | null; // exact; null on miss
  nearestIndexAt(timeIndex: TimeIndex, dir: 'left' | 'right'): number; // total; clamps to ends
}

export class PlotStore<TItem = unknown> implements PlotStoreView {
  readonly #contract: SeriesDataContract<TItem>;
  readonly #laneCount: number;
  readonly #roleCurrent: number;
  readonly #roleMin: number;
  readonly #roleMax: number;
  #lanes: Float64Array[];
  #times = new Int32Array(0);
  #length = 0;
  #chunkMin: number[] = [];
  #chunkMax: number[] = [];

  constructor(contract: SeriesDataContract<TItem>) {
    this.#contract = contract;
    this.#laneCount = contract.laneCount;
    this.#roleCurrent = contract.roles.current;
    this.#roleMin = contract.roles.min;
    this.#roleMax = contract.roles.max;
    this.#lanes = [];
    for (let n = 0; n < this.#laneCount; n++) this.#lanes.push(new Float64Array(0));
  }

  get length(): number {
    return this.#length;
  }

  setData(items: readonly TItem[], timeIndices: readonly number[]): StoreDiff {
    let count = 0;
    for (let i = 0; i < items.length; i++) if (!this.#contract.isWhitespace(items[i])) count++;
    for (let n = 0; n < this.#laneCount; n++) this.#lanes[n] = new Float64Array(count);
    this.#times = new Int32Array(count);
    this.#fillRows(items, timeIndices, 0);
    this.#length = count;
    this.#buildChunksFrom(0);
    return { kind: 'replace' };
  }

  append(items: readonly TItem[], timeIndices: readonly number[]): StoreDiff {
    let add = 0;
    for (let i = 0; i < items.length; i++) if (!this.#contract.isWhitespace(items[i])) add++;
    const oldLen = this.#length;
    const newLen = oldLen + add;
    for (let n = 0; n < this.#laneCount; n++) {
      const bigger = new Float64Array(newLen);
      bigger.set(this.#lanes[n].subarray(0, oldLen));
      this.#lanes[n] = bigger;
    }
    const biggerTimes = new Int32Array(newLen);
    biggerTimes.set(this.#times.subarray(0, oldLen));
    this.#times = biggerTimes;
    this.#fillRows(items, timeIndices, oldLen);
    this.#length = newLen;
    this.#buildChunksFrom(oldLen); // recompute only chunks ≥ the append boundary
    return { kind: 'append', count: add };
  }

  #fillRows(items: readonly TItem[], timeIndices: readonly number[], startRow: number): void {
    const tmp = new Float64Array(this.#laneCount);
    let row = startRow;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (this.#contract.isWhitespace(item)) continue;
      this.#contract.extractLanes(item, tmp, 0);
      for (let n = 0; n < this.#laneCount; n++) this.#lanes[n][row] = tmp[n];
      this.#times[row] = timeIndices[i];
      row++;
    }
  }

  #buildChunksFrom(firstRow: number): void {
    const firstChunk = Math.floor(firstRow / CHUNK);
    const chunks = Math.ceil(this.#length / CHUNK);
    this.#chunkMin.length = chunks;
    this.#chunkMax.length = chunks;
    const minLane = this.#lanes[this.#roleMin];
    const maxLane = this.#lanes[this.#roleMax];
    for (let c = firstChunk; c < chunks; c++) {
      const lo = c * CHUNK;
      const hi = Math.min(lo + CHUNK, this.#length);
      let mn = Number.POSITIVE_INFINITY;
      let mx = Number.NEGATIVE_INFINITY;
      for (let i = lo; i < hi; i++) {
        if (minLane[i] < mn) mn = minLane[i];
        if (maxLane[i] > mx) mx = maxLane[i];
      }
      this.#chunkMin[c] = mn;
      this.#chunkMax[c] = mx;
    }
  }

  /** Overall data range for autoscale: min over the min-role lane, max over max-role. */
  valueRange(): { min: number; max: number } {
    if (this.#length === 0) return { min: Number.NaN, max: Number.NaN };
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    for (let c = 0; c < this.#chunkMin.length; c++) {
      if (this.#chunkMin[c] < mn) mn = this.#chunkMin[c];
      if (this.#chunkMax[c] > mx) mx = this.#chunkMax[c];
    }
    return { min: mn, max: mx };
  }

  timeIndex(i: number): TimeIndex {
    return this.#times[i] as TimeIndex;
  }
  current(i: number): number {
    return this.#lanes[this.#roleCurrent][i];
  }
  min(i: number): number {
    return this.#lanes[this.#roleMin][i];
  }
  max(i: number): number {
    return this.#lanes[this.#roleMax][i];
  }
  lane(n: number, i: number): number {
    return this.#lanes[n][i];
  }

  firstIndexAt(timeIndex: TimeIndex): number | null {
    const ti = timeIndex as number;
    const pos = lowerBound(this.#times, ti, lt, 0, this.#length);
    return pos < this.#length && this.#times[pos] === ti ? pos : null;
  }

  nearestIndexAt(timeIndex: TimeIndex, dir: 'left' | 'right'): number {
    if (this.#length === 0) return -1;
    const ti = timeIndex as number;
    const pos = lowerBound(this.#times, ti, lt, 0, this.#length);
    if (pos < this.#length && this.#times[pos] === ti) return pos; // exact hit
    return dir === 'left' ? Math.max(0, pos - 1) : Math.min(pos, this.#length - 1);
  }
}
