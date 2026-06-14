// views/series/kind.ts — the SeriesKind<Item> interface (architecture §6).
//
// The per-series-type view/renderer class lattice of the reference (base →
// line-base → hit-test-base → per-type, plus parallel renderer bases — study 06
// IMPROVE) collapses into ONE generic series scene-source engine parameterised by
// `SeriesKind<Item>`. `SeriesKind` is the VIEW-SIDE half of a series; the data-side
// half is `SeriesDataContract` (data §4.5.1). A series definition — the
// tree-shakable object passed to `addSeries` — is the pair `{ contract, kind }`.
//
// This interface is re-exported verbatim from the package root by `api` (alongside
// the four engine helper types `ItemBuffer`/`ItemWindow`/`PriceConverter`/
// `HorzGeometry`), and that re-export is the public path custom series and `extras`
// consume — none of them import `views` directly (§3.1; the §3.2 deep-import ban
// applies to module paths, not to `api` re-exports). Every member here is typed in
// terms of `core` primitives, `data` views, `gfx` builders, and the two `model`
// function-bags — never a DOM type.
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { DisplayListBuilder, HitCandidate, ViewFrame } from '../../gfx';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';

export interface SeriesKind<Item> {
  /** Patch the `ItemBuffer` from the store + diff (in place, per diff kind, data
   *  §4.5.2). Normal path only — bypassed entirely on the decimated path. */
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<Item>): void;

  /** Batch-fill the buffer's `x`/`y`/`extra` lanes for the visible `window`, in
   *  place: rows → device X via `horz`, values → media-px Y via `price` (the
   *  points-array fast path, study 04 §4.4). Normal path only. */
  convert(
    items: ItemBuffer<Item>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;

  /** Read the converted lanes and emit style-run + crisp-math display lists via the
   *  supplied builder. Normal path only; output is bit-identical to a non-decimated
   *  renderer (architecture §6 / perf §4.4.3). */
  emit(items: ItemBuffer<Item>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;

  /**
   * Sub-pixel-spacing replacement for the `convert`→`emit` pair (the §13.15
   * decimation path, budgeted by perf §6.3). Invoked INSTEAD OF `convert`+`emit`
   * when bar spacing is sub-pixel (`barSpacing · hr < 1`); reads the SoA lanes
   * directly via `store` (raw `lane(n, i)`) and maps rows → columns through `horz`
   * and values → Y through `price`, writing one min/max segment per device-pixel
   * column into `out`. The `ItemBuffer` is neither populated nor read on this path
   * (so `hitTest` returns null at sub-pixel spacing). All six built-in kinds call
   * the shared `decimateColumns` helper (decimate.ts); a custom kind may delegate
   * to it or supply its own scan.
   */
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;

  /** Hit-test over the converted `ItemBuffer` (the SAME coordinates emit drew, so
   *  hit geometry equals drawn geometry, §5.5). Returns null when the buffer is
   *  unfilled (decimated path) or nothing is under the cursor. */
  hitTest(items: ItemBuffer<Item>, x: Coordinate, y: Coordinate): HitCandidate | null;

  /** Whether the engine must widen the window by ±1 neighbour before passing it
   *  (line-likes need the off-screen segment endpoints; bar-likes do not). */
  readonly extendedRange: boolean;
}
