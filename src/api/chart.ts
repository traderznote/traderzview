// traderzview · api — the IChart facade (spec 02 §7). A THIN wrapper over the
// model ChartModel + the injected host wiring: every handle method maps to a
// model/host call; the facade owns NO business logic the model already has. It is
// the single owner of the §2 identity law (one cached handle per underlying entity,
// `===` across calls) and the §16.5 disposed-guard (after dispose() every method
// throws ChartError('disposed') at the facade boundary, never from deep internals).
// dispose() is idempotent. NEVER imports backend-canvas (§3.1 import wall).
import { assert } from '../core';
import type { DeepPartial, DeepReadonly, Unsubscribe } from '../core';
import type { Snapshot } from '../gfx';
import type { IHorzScaleBehavior } from '../data';
import { UpdateLevel } from '../model';
import type { Pane, Series, ChartModel, ChartOptions } from '../model';
import type { IInteractionRouter } from '../host';
import { ChartErrorCode, throwChartError } from './errors';
import { EventHub, type MouseEventHandler } from './events';
import { normalizeChartPatch, snapshot } from './options';
import type { SeriesType, SeriesDefinition } from './series-defs';
import type { ISeries } from './series';
import type { ITimeScale } from './time-scale';

// --- public handle shapes the chart RETURNS (pane + price-scale handles) ------------
// The full §9 time-scale handle (ITimeScale) is owned by ./time-scale and re-exported
// here. The pane + price-scale handles are owned HERE (the chart is the join point that
// returns + caches them; the sibling pane/price-scale facade IMPLEMENTATIONS satisfy
// these minimal interfaces and add their §10/§11 surface). The chart needs only the
// identity-bearing accessor (`id()` / `index()`) to key + assert the §2 cached-handle
// law; the wiring builds the concrete handle, the chart caches it. Structurally
// compatible with series.ts's IPriceScaleHandle/IPaneHandle (same `id()`/`index()`).

/** A price-scale handle (§10). Cached per (pane, scaleId) — stable identity (§2). */
export interface IPriceScale {
  id(): string;
}

/** A pane handle (§11). One cached handle per live pane — `panes()[i] === panes()[i]` (§2).
 *  The full §11 surface (incl. the H-typed series list) lives in ./pane; this placeholder
 *  is the chart's minimal identity-bearing return type. `H` parameterizes that full handle
 *  (the chart returns the ./pane facade), carried here via an optional phantom so the
 *  generic is honored without re-declaring the whole surface. */
export interface IPane<H = unknown> {
  index(): number;
  /** Phantom: ties the placeholder to its H so `IPane<H>` is sound (never present). */
  readonly __h?: (h: H) => void;
}

// --- the public IChart interface (§7) ----------------------------------------------

/**
 * The chart handle (§7). Generic over the horizontal item `H` (Time in core charts).
 * Lifecycle, series/pane/scale accessors, options, crosshair sync, the extension
 * seams, screenshot, and the three chart events. Every accessor returns a CACHED
 * handle (§2); every method throws after dispose() (§16.5).
 */
export interface IChart<H = unknown> {
  // lifecycle (§7)
  dispose(): void;
  resize(width: number, height: number, forceRepaint?: boolean): void;
  autoSizeActive(): boolean;
  element(): HTMLDivElement;

  // series (§7 / §8)
  addSeries<D extends SeriesDefinition<SeriesType, unknown, unknown>>(
    definition: D,
    options?: DeepPartial<unknown>,
    paneIndex?: number,
  ): ISeries<SeriesType, H>;
  removeSeries(series: ISeries<SeriesType, H>): void;

  // panes (§7 / §11)
  panes(): readonly IPane<H>[];
  addPane(preserveEmptyPane?: boolean): IPane<H>;
  removePane(index: number): void;
  swapPanes(a: number, b: number): void;

  // scales (§7 / §9 / §10)
  timeScale(): ITimeScale<H>;
  priceScale(id: string, paneIndex?: number): IPriceScale;

  // options (§7)
  applyOptions(patch: DeepPartial<ChartOptions>): void;
  options(): DeepReadonly<ChartOptions>;

  // crosshair sync (§7)
  setCrosshairPosition(price: number | null, horzItem: H, series?: ISeries<SeriesType, H>): void;
  clearCrosshairPosition(): void;

  // extension seams (§7)
  horzBehavior(): IHorzScaleBehavior<H>;
  input(): IInteractionRouter;

  // output (§7)
  takeScreenshot(options?: { includeCrosshair?: boolean }): Snapshot;

  // events (§7 / §14)
  subscribeClick(h: MouseEventHandler<H>): Unsubscribe;
  unsubscribeClick(h: MouseEventHandler<H>): void;
  subscribeDblClick(h: MouseEventHandler<H>): Unsubscribe;
  unsubscribeDblClick(h: MouseEventHandler<H>): void;
  subscribeCrosshairMove(h: MouseEventHandler<H>): Unsubscribe;
  unsubscribeCrosshairMove(h: MouseEventHandler<H>): void;
}

// --- the chart-owned host slice + injected wiring (create-chart.ts supplies these) -

/** The host surface the chart drives, narrowed to exactly what §7 calls. The concrete
 *  ChartHost satisfies it structurally, so chart.ts never names the backend (§3.1). */
export interface ChartHostFacade {
  /** Apply a requested outer size (resize → synchronous forced layout flush, §7). */
  setSize(size: { width: number; height: number }): void;
  /** Flush pending invalidations, then composite a screenshot (§7). `includeCrosshair`
   *  (default true) toggles the overlay (crosshair) layer in the composite (§8.6). */
  takeScreenshot(includeCrosshair?: boolean): Snapshot;
  /** The interaction router (chart.input(), §13.5). */
  input(): IInteractionRouter;
  /** Tear down surfaces, frame loop, router (chart.dispose path). */
  dispose(): void;
}

/**
 * Everything the chart facade delegates structural work to. Create-chart wires these
 * (real model mutation + the sibling handle factories); tests pass recording fakes.
 * The chart owns the disposed flag, the identity CACHES, and the event hubs — the
 * wiring owns model/store mutation and the concrete sibling-handle construction.
 */
export interface ChartWiring<H = unknown> {
  /** Build a fresh model Series for `definition` into pane `paneIndex` (creating the
   *  pane when `paneIndex === paneCount`, §7). The data store/views kind are wired by
   *  create-chart; the chart caches the returned handle by the model Series (§2). */
  createSeries(
    definition: SeriesDefinition<SeriesType, unknown, unknown>,
    options: DeepPartial<unknown> | undefined,
    paneIndex: number,
  ): { model: Series; handle: ISeries<SeriesType, H> };
  /** Tear down a series' store/views/membership (the inverse of createSeries). */
  destroySeries(model: Series): void;
  /** Build the cached pane handle for a model Pane (§2 identity is the chart's cache). */
  createPane(pane: Pane): IPane<H>;
  /** Build the singleton time-scale handle (§2). Called once, then cached. */
  createTimeScale(): ITimeScale<H>;
  /** Build the cached price-scale handle for a (pane, scaleId) (§2). */
  createPriceScale(pane: Pane, scaleId: string): IPriceScale;
  /** Apply the time-line-only / full crosshair position by key (§7). No-op contracts
   *  (unknown series, empty scale) live in the model wiring; the facade just forwards. */
  setCrosshairPosition(price: number | null, horzItem: H, series: Series | null): void;
  clearCrosshairPosition(): void;
  /** Resolve the model Series backing a public handle, or null when foreign (removeSeries). */
  seriesModel(handle: ISeries<SeriesType, H>): Series | null;
  /** The three chart event hubs (§14). Create-chart owns + FIRES these from the host
   *  pointer pipeline (lazy build behind hasListeners()); the facade only exposes the
   *  subscribe/unsubscribe pairs and tears them down on dispose. */
  readonly events: {
    readonly click: EventHub<Parameters<MouseEventHandler<H>>>;
    readonly dblClick: EventHub<Parameters<MouseEventHandler<H>>>;
    readonly crosshairMove: EventHub<Parameters<MouseEventHandler<H>>>;
  };
}

/** The shared disposed cell (§16.5). The chart flips `value` in dispose(); every other
 *  facade (series via SeriesPort.isDisposed, the pane/scale handles) reads the SAME
 *  object, so the disposed-guard is chart-wide from one source of truth. Create-chart
 *  mints it, hands it here AND to every sibling facade's port. */
export interface DisposedCell {
  value: boolean;
}

export interface ChartApiDeps<H = unknown> {
  readonly model: ChartModel<H>;
  readonly host: ChartHostFacade;
  readonly behavior: IHorzScaleBehavior<H>;
  readonly wiring: ChartWiring<H>;
  /** The chart-wide disposed cell (§16.5) — shared with every sibling facade's port. */
  readonly disposed: DisposedCell;
  /** The generated container div (the api creates it; §7 element()). */
  readonly element: HTMLDivElement;
  /** The live bar spacing px→bars resolves against in normalizeChartPatch (§5.3.4). */
  readonly barSpacing: () => number;
}

// --- the facade factory ------------------------------------------------------------

/**
 * Build the IChart facade (§7). `createChartWith` calls this once, having built the
 * model + host + wiring; `createChart` is the tree-shaken sugar that injects the
 * default canvas backend (the ONLY place backend-canvas is imported, §3.1). The
 * returned handle is the chart's public identity for its life.
 */
export function createChartApi<H = unknown>(deps: ChartApiDeps<H>): IChart<H> {
  const { model, host, behavior, wiring } = deps;

  // The shared disposed cell (§16.5): every facade of this chart — series, pane,
  // scales — guards on the SAME object; here it gates every chart method. The chart
  // flips it in dispose(); after that every sibling facade throws too (§16.5).
  const disposedCell = deps.disposed;
  const guard = (): void => {
    if (disposedCell.value) throwChartError(ChartErrorCode.Disposed);
  };

  // --- §2 identity caches: one handle per underlying entity ------------------------
  // Pane / series caches are keyed by the model object (WeakMap so a removed entity's
  // handle is collectable). Price scales are a per-pane (scaleId → handle) map so a
  // DESTROYED overlay id mints a FRESH handle on re-creation (§10 — identity covers
  // live objects, not reincarnations). The time scale is a single cached singleton.
  const paneHandles = new WeakMap<Pane, IPane<H>>();
  const priceScaleHandles = new WeakMap<Pane, Map<string, IPriceScale>>();
  let timeScaleHandle: ITimeScale<H> | null = null;

  const paneHandle = (pane: Pane): IPane<H> => {
    let h = paneHandles.get(pane);
    if (h === undefined) {
      h = wiring.createPane(pane);
      paneHandles.set(pane, h);
    }
    return h;
  };

  const priceScaleHandle = (pane: Pane, scaleId: string): IPriceScale => {
    let byId = priceScaleHandles.get(pane);
    if (byId === undefined) {
      byId = new Map();
      priceScaleHandles.set(pane, byId);
    }
    let h = byId.get(scaleId);
    if (h === undefined) {
      h = wiring.createPriceScale(pane, scaleId);
      byId.set(scaleId, h);
    }
    return h;
  };

  // --- the three chart event hubs (§14): owned by the wiring, FIRED by create-chart's
  // host pipeline (lazy build behind hasListeners()). The facade only exposes the
  // subscribe/unsubscribe pairs + tears them down on dispose.
  const { click: clickHub, dblClick: dblClickHub, crosshairMove: crosshairHub } = wiring.events;

  const panesArray = (): readonly Pane[] => model.panes().panes();
  const paneAt = (index: number): Pane => {
    const list = panesArray();
    if (index < 0 || index >= list.length) {
      throw new RangeError(`pane index ${index} out of bounds`);
    }
    return list[index]!;
  };

  const api: IChart<H> = {
    // --- lifecycle ----------------------------------------------------------------
    dispose(): void {
      if (disposedCell.value) return; // idempotent (§7)
      disposedCell.value = true;
      clickHub.dispose();
      dblClickHub.dispose();
      crosshairHub.dispose();
      host.dispose();
    },

    resize(width, height, _forceRepaint): void {
      guard();
      // Under autoSize the size is driven by the ResizeObserver: resize is a no-op +
      // warn (§7 / §16.4). Otherwise apply the explicit outer size through the host.
      if (model.options().autoSize) {
        console.warn('resize() is a no-op while autoSize is active (spec 02 §7)');
        return;
      }
      host.setSize({ width, height });
    },

    autoSizeActive(): boolean {
      guard();
      return model.options().autoSize;
    },

    element(): HTMLDivElement {
      guard();
      return deps.element;
    },

    // --- series -------------------------------------------------------------------
    addSeries(definition, options, paneIndex): ISeries<SeriesType, H> {
      guard();
      // Reject a foreign object that is not a definition pair (§16.3).
      if (
        definition === null ||
        typeof definition !== 'object' ||
        typeof (definition as { createKind?: unknown }).createKind !== 'function'
      ) {
        throwChartError(ChartErrorCode.UnknownSeriesDefinition);
      }
      // paneIndex defaults to 0; === paneCount creates the pane (§7). Out of range is
      // a RangeError (§16.2). The wiring owns model/store creation; we cache by Series.
      const count = model.panes().count();
      const target = paneIndex ?? 0;
      if (target < 0 || target > count) {
        throw new RangeError(`pane index ${target} out of bounds`);
      }
      const { handle } = wiring.createSeries(
        definition as SeriesDefinition<SeriesType, unknown, unknown>,
        options as DeepPartial<unknown> | undefined,
        target,
      );
      return handle;
    },

    removeSeries(series): void {
      guard();
      const m = wiring.seriesModel(series);
      if (m !== null) wiring.destroySeries(m);
    },

    // --- panes --------------------------------------------------------------------
    panes(): readonly IPane<H>[] {
      guard();
      return panesArray().map(paneHandle);
    },

    addPane(_preserveEmptyPane): IPane<H> {
      guard();
      const pane = model.panes().addPane();
      // A structural change needs the host to re-sync its surface row tree → Layout.
      model.invalidate(UpdateLevel.Layout);
      return paneHandle(pane);
    },

    removePane(index): void {
      guard();
      const list = panesArray();
      if (index < 0 || index >= list.length) {
        throw new RangeError(`pane index ${index} out of bounds`);
      }
      if (list.length === 1) return; // removing the last pane is a no-op (§7 / §16.4)
      model.panes().removePane(list[index]!);
      model.invalidate(UpdateLevel.Layout);
    },

    swapPanes(a, b): void {
      guard();
      model.panes().swapPanes(a, b); // throws RangeError out of bounds (§16.2)
      model.invalidate(UpdateLevel.Layout);
    },

    // --- scales -------------------------------------------------------------------
    timeScale(): ITimeScale<H> {
      guard();
      if (timeScaleHandle === null) timeScaleHandle = wiring.createTimeScale();
      return timeScaleHandle;
    },

    priceScale(id, paneIndex): IPriceScale {
      guard();
      // Resolve immediately (§10): an id absent from that pane throws no-such-scale at
      // the call. 'left'/'right' always exist on a live pane; overlays exist only while
      // a series sits on them. The cache mints a fresh handle for a re-created overlay.
      const pane = paneAt(paneIndex ?? 0);
      if (pane.priceScale(id) === null) {
        throwChartError(ChartErrorCode.NoSuchScale, id);
      }
      return priceScaleHandle(pane, id);
    },

    // --- options ------------------------------------------------------------------
    applyOptions(patch): void {
      guard();
      // Run the §5.3 chart normalizations (handleScroll/handleScale expand, §5.3.1;
      // rightOffsetPixels px→bars, §5.3.4) at the boundary, then let the MODEL own the
      // merge against its effective-defaults reset target (§5.1 — the model already
      // does normalize→merge→one-mask invalidation). The model owns only its option
      // subset; the time-scale/price-scale groups in the same normalized patch are
      // forwarded by create-chart's wiring (it observes the same patch).
      const normalized = normalizeChartPatch(patch as Record<string, unknown>, deps.barSpacing());
      model.applyOptions(normalized as DeepPartial<ChartOptions>);
    },

    options(): DeepReadonly<ChartOptions> {
      guard();
      // The §4.3 snapshot law is the public BOUNDARY's job: a fresh deep copy, deep-
      // FROZEN in dev. The model already returns a non-aliasing clone; `snapshot` adds
      // the dev freeze so an accidental write on the returned object throws.
      return snapshot(model.options());
    },

    // --- crosshair sync -----------------------------------------------------------
    setCrosshairPosition(price, horzItem, series): void {
      guard();
      // Full form (numeric price) REQUIRES the series (§7); both the unknown/unpaned
      // series no-op and the empty-scale no-op live in the model wiring (§7 / §16.4).
      if (__DEV__) {
        assert(price === null || series !== undefined, 'setCrosshairPosition: series is required when price is numeric (§7)');
      }
      const m = series !== undefined ? wiring.seriesModel(series) : null;
      wiring.setCrosshairPosition(price, horzItem, m);
    },

    clearCrosshairPosition(): void {
      guard();
      wiring.clearCrosshairPosition();
    },

    // --- extension seams ----------------------------------------------------------
    horzBehavior(): IHorzScaleBehavior<H> {
      guard();
      return behavior;
    },

    input(): IInteractionRouter {
      guard();
      return host.input();
    },

    // --- output -------------------------------------------------------------------
    takeScreenshot(options): Snapshot {
      guard();
      // The host flushes pending invalidations first (§7), then composites. A false
      // includeCrosshair omits the overlay layer (§8.6); default true keeps it.
      return host.takeScreenshot(options?.includeCrosshair ?? true);
    },

    // --- events (§14) -------------------------------------------------------------
    subscribeClick(h): Unsubscribe {
      guard();
      return clickHub.subscribe(h);
    },
    unsubscribeClick(h): void {
      guard();
      clickHub.unsubscribe(h);
    },
    subscribeDblClick(h): Unsubscribe {
      guard();
      return dblClickHub.subscribe(h);
    },
    unsubscribeDblClick(h): void {
      guard();
      dblClickHub.unsubscribe(h);
    },
    subscribeCrosshairMove(h): Unsubscribe {
      guard();
      return crosshairHub.subscribe(h);
    },
    unsubscribeCrosshairMove(h): void {
      guard();
      crosshairHub.unsubscribe(h);
    },
  };

  return api;
}
