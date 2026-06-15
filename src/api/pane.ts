// traderzview · api — the IPane facade (spec 02 §11). A THIN wrapper over the model
// Pane (pane-manager + per-pane scales/series) via an injected port; owns NO business
// logic the model has. Identity (§2): the CHART caches one handle per live pane, so
// panes()[i] === panes()[i] and this factory runs once per pane. Disposed-guard
// (§16.5): after chart.dispose() every method throws disposed. Boundary rules the
// facade owns: priceScale(id) resolves NOW — an absent id throws no-such-scale
// (§10/§11). index() is the live position; id() is the never-reused creation identity
// ('p0','p1',… — survives moveTo/removePane/swapPanes, §11). NEVER imports backend-canvas.
import type { IPrimitive } from '../model';
import { ChartErrorCode, throwChartError } from './errors';
import type { SeriesType, SeriesDefinition } from './series-defs';

// --- supporting public shapes (§11) ------------------------------------------------
// Opaque sibling-handle types the facade RETURNS through its port — the chart owns
// their concrete shape + identity cache (§2). Typed minimally so pane.ts imports no
// facade sibling (same shape as chart.ts's IPriceScale / series.ts's IPaneHandle).

/** A price-scale handle the pane resolves (§10). Cached per (pane, scaleId) (§2). */
export interface IPriceScaleHandle {
  id(): string;
}
/** A series handle the pane lists / creates (§8). One per live series (§2). */
export interface ISeriesHandle {
  seriesType(): string;
}

// --- the public IPane interface (§11) ----------------------------------------------

/** The pane handle (§11). Positional `index()` vs persistent never-reused `id()`
 *  ('p0','p1',…, survives moveTo/removePane/swapPanes); geometry/stretch, structural
 *  `moveTo`, the series list, immediate price-scale resolution, pane-scoped addSeries,
 *  the empty-pane flag, the host element, the pane-attached primitive seam (§12). One
 *  cached handle per live pane (§2); every method throws after dispose() (§16.5). */
export interface IPane<H = unknown> {
  index(): number;
  id(): string;
  size(): { width: number; height: number };
  height(): number;
  setHeight(px: number): void;
  stretchFactor(): number;
  setStretchFactor(f: number): void;
  moveTo(index: number): void;
  series(): readonly ISeriesHandle[];
  priceScale(id: string): IPriceScaleHandle;
  addSeries<D extends SeriesDefinition<SeriesType, unknown, unknown>>(
    definition: D,
    options?: unknown,
  ): ISeriesHandle;
  preserveEmptyPane(): boolean;
  setPreserveEmptyPane(keep: boolean): void;
  element(): HTMLElement | null;
  attachPrimitive(p: IPrimitive): void;
  detachPrimitive(p: IPrimitive): void;
  /** Phantom: ties the handle to the chart's H (the spec's series()/primitives are
   *  H-typed; the facade returns opaque handles, so H surfaces only here). Never set. */
  readonly __h?: (h: H) => void;
}

// --- the chart-owned port (injected by create-chart.ts) ----------------------------

/** Everything the pane facade delegates to (a pure map-through over the model Pane +
 *  pane-manager + host pane widget). Mirrors IPane minus addSeries' generic (loose) and
 *  priceScale (nullable here: the chart's CACHED handle, or null when the id is absent
 *  in this pane → the facade maps null to no-such-scale, §10/§11), plus the shared
 *  disposed flag (§16.5). The model owns setHeight redistribution + the 30 px floor and
 *  the moveTo bounds check (§11/§16.2). */
export interface PanePort<H = unknown> extends Omit<IPane<H>, 'addSeries' | 'priceScale'> {
  isDisposed(): boolean;
  addSeries(definition: SeriesDefinition<SeriesType, unknown, unknown>, options: unknown): ISeriesHandle;
  priceScale(id: string): IPriceScaleHandle | null;
}

// --- the facade factory ------------------------------------------------------------

/**
 * Build the cached IPane facade for one model Pane (§2: the chart calls this once per
 * pane and caches it). Every method guards the shared disposed flag first (§16.5), then
 * maps to the port; priceScale(id) resolves immediately — null (no such scale here)
 * throws no-such-scale (§10/§11), while 'left'/'right' always resolve on a live pane
 * whatever their visibility and an overlay id only while a series sits on it.
 */
export function createPaneApi<H = unknown>(port: PanePort<H>): IPane<H> {
  const guard = (): void => {
    if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
  };

  const api: IPane<H> = {
    // --- identity (positional index renumbers; id is minted once, never reused) ----
    index(): number {
      guard();
      return port.index();
    },
    id(): string {
      guard();
      return port.id();
    },

    // --- geometry / stretch (model owns redistribution + the 30 px floor) ----------
    size(): { width: number; height: number } {
      guard();
      return port.size();
    },
    height(): number {
      guard();
      return port.height();
    },
    setHeight(px): void {
      guard();
      port.setHeight(px);
    },
    stretchFactor(): number {
      guard();
      return port.stretchFactor();
    },
    setStretchFactor(f): void {
      guard();
      port.setStretchFactor(f);
    },
    moveTo(index): void {
      guard();
      port.moveTo(index); // RangeError out of bounds from the model (§11/§16.2)
    },

    // --- series (cached handles §2; addSeries targets THIS pane, §11) --------------
    series(): readonly ISeriesHandle[] {
      guard();
      return port.series();
    },
    addSeries(definition, options): ISeriesHandle {
      guard();
      return port.addSeries(definition as SeriesDefinition<SeriesType, unknown, unknown>, options);
    },

    // --- price scale (immediate resolution; null → no-such-scale, §10/§11) ---------
    priceScale(id): IPriceScaleHandle {
      guard();
      const handle = port.priceScale(id);
      if (handle === null) throwChartError(ChartErrorCode.NoSuchScale, id);
      return handle;
    },

    // --- empty-pane retention / host element / primitives (§11 / §12) --------------
    preserveEmptyPane(): boolean {
      guard();
      return port.preserveEmptyPane();
    },
    setPreserveEmptyPane(keep): void {
      guard();
      port.setPreserveEmptyPane(keep);
    },
    element(): HTMLElement | null {
      guard();
      return port.element();
    },
    attachPrimitive(p): void {
      guard();
      port.attachPrimitive(p);
    },
    detachPrimitive(p): void {
      guard();
      port.detachPrimitive(p);
    },
  };

  return api;
}
