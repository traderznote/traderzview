// One pane (architecture §4.6 pane row; study 01, study 04 are the spec of record).
// A pane owns: its never-reused id (`'p0','p1',…`, minted by pane-manager.ts), its
// stretch factor, the default left/right price-scale pair + any overlay scales it
// hosts, and its per-pane series membership. It is pure model state — no DOM, no
// gfx (architecture §3.1).
import { mergeOptions, type DeepPartial } from '../core';
import { PriceNavigator } from './price-scale/navigator';
import { PriceScaleMode, isAutoScaleForced, type MinMax } from './price-scale/modes';
import { DEFAULT_PRICE_SCALE_OPTIONS, type PaneId, type PriceScaleOptions } from './shared';

/** A series object as the pane sees it — kept structural (the concrete `Series`
 *  lives in `series.ts`; the pane only needs identity + kind for membership). */
export interface PaneSeries {
  kind(): string;
}

/** A price scale within a pane (architecture §4.6 / §4.3). The options owner +
 *  the manual-interaction navigator (drag state) + the mode flag. Geometry is
 *  built per frame by `shared.buildPriceConverter`; this object holds STATE only. */
export class PriceScale {
  readonly #id: string;
  readonly #defaults: PriceScaleOptions;
  #options: PriceScaleOptions;
  readonly #navigator: PriceNavigator;

  constructor(id: string, defaults: PriceScaleOptions) {
    this.#id = id;
    this.#defaults = defaults;
    this.#options = { ...defaults, scaleMargins: { ...defaults.scaleMargins } };
    this.#navigator = new PriceNavigator({
      range: null,
      autoScale: defaults.autoScale,
      mode: defaults.mode,
      inverted: defaults.invertScale,
      height: 0,
    });
  }

  id(): string {
    return this.#id;
  }

  /** A snapshot of the merged options — never the live object (architecture §4.3). */
  options(): PriceScaleOptions {
    return { ...this.#options, scaleMargins: { ...this.#options.scaleMargins } };
  }

  /** Apply an options patch through the ONE merge path (architecture §4.3). Entering
   *  Percentage / Indexed forces autoScale ← true (study 04 §3.5), and the navigator
   *  mirrors the resulting mode + autoScale flags so its scale/scroll refusal rules
   *  stay consistent with the options. */
  applyOptions(patch: DeepPartial<PriceScaleOptions>): void {
    this.#options = mergeOptions(this.#options, patch, this.#defaults);
    if (isAutoScaleForced(this.#options.mode)) {
      this.#options = { ...this.#options, autoScale: true };
    }
    this.#navigator.setMode(this.#options.mode);
    this.#navigator.setAutoScale(this.#options.autoScale);
  }

  mode(): PriceScaleMode {
    return this.#options.mode;
  }

  isAutoScale(): boolean {
    return this.#navigator.isAutoScale();
  }

  /** The live (logical-space) range, or null on an empty/unset scale. */
  range(): MinMax | null {
    return this.#navigator.range();
  }

  setRange(range: MinMax | null): void {
    this.#navigator.setRange(range);
  }

  /** The drag-state navigator (axis scale/scroll). Recognizer lives in host/input. */
  navigator(): PriceNavigator {
    return this.#navigator;
  }
}

export class Pane {
  readonly #id: PaneId;
  #stretchFactor = 1;
  #preserveEmpty = false;
  readonly #scales = new Map<string, PriceScale>();
  readonly #series: PaneSeries[] = [];

  constructor(id: PaneId) {
    this.#id = id;
    // The default left/right scale pair (architecture §4.6; design 02 §6.6).
    this.#scales.set('right', new PriceScale('right', DEFAULT_PRICE_SCALE_OPTIONS.right));
    this.#scales.set('left', new PriceScale('left', DEFAULT_PRICE_SCALE_OPTIONS.left));
  }

  id(): PaneId {
    return this.#id;
  }

  stretchFactor(): number {
    return this.#stretchFactor;
  }
  setStretchFactor(f: number): void {
    this.#stretchFactor = f;
  }

  /** Empty-pane retention policy (design 02 §11): when true, an empty pane is kept. */
  preserveEmptyPane(): boolean {
    return this.#preserveEmpty;
  }
  setPreserveEmptyPane(keep: boolean): void {
    this.#preserveEmpty = keep;
  }

  /** The price scale by id, or null when this pane has no such scale (design 02 §11
   *  — the public IPane.priceScale throws; the model accessor returns null and the
   *  api layer maps the miss to a ChartError). */
  priceScale(id: string): PriceScale | null {
    return this.#scales.get(id) ?? null;
  }

  /** Ensure (create-on-demand) an overlay scale for a non-left/right id (design 02
   *  §6.6). Returns the existing scale when the id is already present. */
  ensureOverlayScale(id: string): PriceScale {
    const existing = this.#scales.get(id);
    if (existing !== undefined) return existing;
    // Overlay scales drop `visible`/`autoScale`-from-options; they always autoscale
    // and never render a border axis (design 02 §6.6 OverlayPriceScaleOptions).
    const overlay = new PriceScale(id, { ...DEFAULT_PRICE_SCALE_OPTIONS.right, visible: false });
    this.#scales.set(id, overlay);
    return overlay;
  }

  /** Every price scale this pane hosts (left, right, then overlays in insertion order). */
  priceScales(): readonly PriceScale[] {
    return [...this.#scales.values()];
  }

  // --- series membership --------------------------------------------------------

  series(): readonly PaneSeries[] {
    return this.#series.slice();
  }

  addSeries(series: PaneSeries): void {
    this.#series.push(series);
  }

  removeSeries(series: PaneSeries): void {
    const i = this.#series.indexOf(series);
    if (i >= 0) this.#series.splice(i, 1);
  }

  /** Whether the pane carries no series (used by the empty-pane retention rule). */
  isEmpty(): boolean {
    return this.#series.length === 0;
  }
}
