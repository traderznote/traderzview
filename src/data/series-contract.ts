// SeriesDataContract (architecture §4.5) — the data-side half of a series
// definition. It teaches the columnar PlotStore a series' lane count and how to
// pull lane values from a user item, without `data` ever importing `views`. The
// view-side half is SeriesKind (views, M7).

export interface SeriesDataContract<TItem = unknown> {
  readonly laneCount: 1 | 2 | 3 | 4;
  // role → lane index, so readers (autoscale, crosshair, price lines, emitters)
  // never branch on lane count.
  readonly roles: { readonly current: number; readonly min: number; readonly max: number };
  isWhitespace(item: TItem): boolean; // occupies a timeline slot, but yields no plot row
  extractLanes(item: TItem, out: Float64Array, offset: number): void; // writes laneCount values
}

interface SingleValueItem {
  value?: number;
}
interface BarItem {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

/** Line / Area / Baseline / Histogram: one lane — the 1-lane store halves memory. */
export const singleValueContract: SeriesDataContract<SingleValueItem> = {
  laneCount: 1,
  roles: { current: 0, min: 0, max: 0 },
  isWhitespace: (item) => item.value === undefined,
  extractLanes: (item, out, offset) => {
    out[offset] = item.value ?? 0;
  },
};

/** Bar / Candlestick: four lanes [open, high, low, close]. */
export const barContract: SeriesDataContract<BarItem> = {
  laneCount: 4,
  roles: { current: 3, min: 2, max: 1 },
  isWhitespace: (item) => item.open === undefined,
  extractLanes: (item, out, offset) => {
    out[offset] = item.open ?? 0;
    out[offset + 1] = item.high ?? 0;
    out[offset + 2] = item.low ?? 0;
    out[offset + 3] = item.close ?? 0;
  },
};
