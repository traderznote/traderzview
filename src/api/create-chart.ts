// traderzview · api — the JOIN POINT (design 02 §3.1; design 01 §8). createChartWith
// builds the model (M5) + views scene (M7) + host (M8) over an INJECTED render backend
// and returns the IChart facade (chart.ts). createChart is the tree-shaken sugar that
// injects the default canvas backend — the ONLY file in `api` that may import
// backend-canvas (§3.1 import wall; dep-cruiser enforces it). The wiring is the thin
// glue between the headless model/views and the DOM host: the data pipeline (Timeline +
// PlotStore + SeriesKind → PaneScene SceneSource), the §2 cached-handle ports, and the
// §14 event hubs the host pointer pipeline fires.
import type { Coordinate, DeepPartial, IFrameCounters } from '../core';
import { createFrameCounters } from '../core';
import type { DisplayList, IRenderBackend, SceneSource, ViewFrame } from '../gfx';
import { DisplayListBuilder, ZBand } from '../gfx';
import { PlotStore, Timeline, timeBehavior } from '../data';
import type { IHorzScaleBehavior, PlotStoreView, Time } from '../data';
import {
  ChartModel,
  PriceScaleMode,
  Series as ModelSeries,
  UpdateLevel,
  buildHorzGeometry,
  buildPriceConverter,
} from '../model';
import type { Pane, ChartOptions, IPrimitive as ModelIPrimitive } from '../model';
import { ChartHost, createRafScheduler } from '../host';
import type {
  ChartHostHooks,
  ElementFactory,
  FrameProfiler,
  HostElement,
  IFrameScheduler,
  IPerfSink,
  MeasuredAxes,
  PaneSurfaceConfigs,
} from '../host';
import { PaneScene, PrimitiveBinding, itemWindow, createPriceLineSource } from '../views';
import type {
  ItemBuffer,
  OwnerPlacement,
  PriceLineSource,
  PriceLineState,
  SeriesKind,
  SurfaceKind,
  TaggedPrimitiveSource,
} from '../views';
import { createChartApi } from './chart';
import type { ChartWiring, DisposedCell, IChart, IPane, IPriceScale } from './chart';
import { createSeriesApi } from './series';
import type { ISeries, IPriceLine, LogicalRange, PriceLineOptions, SeriesPort } from './series';
import { createTimeScaleApi } from './time-scale';
import type { ITimeScale, TimeRange } from './time-scale';
import { createPriceScaleApi } from './price-scale';
import type { PriceScalePort } from './price-scale';
import { createPaneApi } from './pane';
import type { PanePort } from './pane';
import { createPriceLineApi } from './price-line';
import type { IPrimitive, PrimitiveContext } from './primitives';
import { EventHub, type MouseEventHandler, type StoreDiff } from './events';
import { ChartErrorCode, throwChartError } from './errors';
import { createSeriesOptions, snapshot } from './options';
import type { SeriesDefinition, SeriesType } from './series-defs';

/** Optional injection seam (design 02 §3.1): share one rAF loop across charts (§13.6)
 *  and, under __TV_PROFILE__ ONLY, the bench instrumentation (perf §9.6). `perfSink`
 *  receives one FrameStats per painted frame; `frameCounters` is the per-frame
 *  accumulator the producing layers ++ (a fresh one is created if omitted). Both fields
 *  and all their wiring compile out without the define (byte-identical, perf §3.3.1). */
export interface ChartEnvironment {
  scheduler?: IFrameScheduler;
  perfSink?: IPerfSink;
  frameCounters?: IFrameCounters;
}

interface ItemWithTime {
  time: unknown;
}

/** One fully wired series: model Series ↔ PlotStore ↔ shared Timeline ↔ SeriesKind
 *  (exposed as a PaneScene SceneSource), plus its public handle (§2 cached). */
interface Wired<H> {
  readonly model: ModelSeries;
  readonly handle: ISeries<SeriesType, H>;
  readonly pane: Pane;
  readonly scene: PaneScene;
  readonly source: SceneSource; // the registered SceneSource — unregistered on removeSeries
  readonly paneSeries: Parameters<Pane['addSeries']>[0]; // the model PaneSeries — removed on removeSeries
  /** Unregister this series' price-line SceneSources from the pane scene (removeSeries). */
  disposeExtras(): void;
}

/**
 * createChartWith — the explicit factory (design 02 §3.1). Resolves the container,
 * builds the model + host over the injected backend, wires the §2 ports + §14 hubs,
 * and returns the cached IChart handle (§7). `H` is the behavior's horizontal item.
 */
export function createChartWith<H = Time>(
  container: HTMLElement | string,
  backend: IRenderBackend,
  behavior: IHorzScaleBehavior<H>,
  options?: DeepPartial<ChartOptions>,
  env?: ChartEnvironment,
): IChart<H> {
  const mount = resolveContainer(container); // §3.1: string id → element, miss throws

  // The generated chart div (the api owns it; §7 element()). Mounted into the container.
  const doc = mount.ownerDocument ?? document;
  const element = doc.createElement('div');
  element.style.position = 'relative';
  mount.appendChild(element);

  const disposed: DisposedCell = { value: false }; // the chart-wide §16.5 cell

  // The model: the headless source of truth (M5). Its one invalidate callback is wired
  // to the host frame loop (the model never schedules — "model mask, host scheduler").
  // The behavior's internal item type `I` is opaque to the core (§13.3); the model +
  // timeline are I-agnostic, so we hand them the behavior with I erased to `unknown`.
  const beh = behavior as unknown as IHorzScaleBehavior<H, unknown>;
  let host: ChartHost | null = null;
  const model = new ChartModel<H, unknown>({
    behavior: beh,
    invalidate: (mask) => host?.invalidate(mask),
    options,
  });

  const timeline = new Timeline<ItemWithTime, H, unknown>(beh);

  // perf §9.6: under __TV_PROFILE__ ONLY, the single per-chart frame-counter accumulator
  // (env-supplied or fresh) + the FrameProfiler the host threads into its frame loop.
  // The producing layers (timeline + each series' store/buffer, below) are handed the
  // SAME instance via setCounters so their `++`s land where the host reads them at
  // endFrame. The whole block — and `counters` itself — strips to nothing without the
  // define (byte-identical, perf §3.3.1).
  let counters: IFrameCounters | undefined;
  let profiler: FrameProfiler | undefined;
  // perf §4.4.9 inputLagFrames source (M11): the gesture/hover hooks mark when an
  // UNCONSUMED input event drove an invalidation; `inputLagFrames()` is read once per
  // painted frame (at endFrame) and reports how many rAF periods elapsed from that
  // input to this paint, then consumes the marker. __TV_PROFILE__-only — `markInput`
  // and the whole tracker strip out without the define (perf §3.3.1).
  const inputLag = { frameSeq: 0, inputSeq: -1, pending: false };
  const markInput = (): void => {
    if (__TV_PROFILE__ && !inputLag.pending) {
      inputLag.inputSeq = inputLag.frameSeq;
      inputLag.pending = true;
    }
  };
  if (__TV_PROFILE__) {
    counters = env?.frameCounters ?? createFrameCounters();
    timeline.setCounters(counters);
    const sink: IPerfSink = env?.perfSink ?? { onFrame: () => {} };
    // A monotonic wall clock for the *Ms brackets — `performance.now()` where present
    // (browser/Node), else `Date.now()`. Read off globalThis so headless tsconfig needs
    // no lib.dom (the same discipline as queueMicrotask in globals.d.ts).
    const g = globalThis as { performance?: { now(): number }; Date: { now(): number } };
    const wallNow = (): number => (g.performance !== undefined ? g.performance.now() : g.Date.now());
    const c = counters;
    // One paint per call (read at endFrame): advance the frame counter, then the lag is
    // (this paint's seq − the input's seq), consumed so a later input-free frame reports 0.
    const inputLagFrames = (): number => {
      inputLag.frameSeq++;
      if (!inputLag.pending) return 0;
      inputLag.pending = false;
      return Math.max(0, inputLag.frameSeq - inputLag.inputSeq);
    };
    profiler = { counters: c, sink, now: wallNow, inputLagFrames };
  }

  const wired = new Map<ModelSeries, Wired<H>>();
  const scenes = new Map<Pane, PaneScene>();
  const sceneFor = (pane: Pane): PaneScene => {
    let s = scenes.get(pane);
    if (s === undefined) (s = new PaneScene()), scenes.set(pane, s);
    return s;
  };
  let ownerSeq = 0;

  // §2 IDENTITY LAW: ONE cached handle per pane and per (pane, price-scale id), shared by
  // EVERY resolver — chart.panes()/priceScale(), series.pane()/priceScale(), pane.priceScale()
  // — so they all return the SAME object (===). A destroyed overlay scale's handle latches
  // dead (§10) and is never revived; a re-created id mints a FRESH handle.
  const paneHandles = new Map<Pane, IPane<H>>();
  const priceScaleHandles = new Map<string, { handle: IPriceScale; alive: () => boolean }>();
  const priceScaleHandle = (pane: Pane, scaleId: string): IPriceScale => {
    const key = `${pane.id()}\u0000${scaleId}`;
    const cached = priceScaleHandles.get(key);
    if (cached !== undefined && cached.alive()) return cached.handle; // live → reuse (§2)
    const made = makePriceScaleHandle(pane, scaleId, disposed); // absent or dead → fresh (§10)
    priceScaleHandles.set(key, made);
    return made.handle;
  };
  // The §12 pane-attached primitive hooks. Forward-declared here (paneHandle is built
  // before the binder exists) and populated once the binder/ctxFor are wired below; a
  // pane handle calls through these at user-attach time, long after construction.
  let panePrimitiveAttach: (pane: Pane, p: ModelIPrimitive) => void = () => {};
  let panePrimitiveDetach: (p: ModelIPrimitive) => void = () => {};
  const paneHandle = (pane: Pane): IPane<H> => {
    let h = paneHandles.get(pane);
    if (h === undefined) {
      h = makePaneHandle<H>(
        pane,
        model,
        disposed,
        priceScaleHandle,
        (p) => panePrimitiveAttach(pane, p),
        (p) => panePrimitiveDetach(p),
      );
      paneHandles.set(pane, h);
    }
    return h;
  };

  const events = {
    click: new EventHub<Parameters<MouseEventHandler<H>>>(),
    dblClick: new EventHub<Parameters<MouseEventHandler<H>>>(),
    crosshairMove: new EventHub<Parameters<MouseEventHandler<H>>>(),
  };

  // Resolve the initial outer size (width/height options, else the container rect, §6.1).
  const rect = mount.getBoundingClientRect();
  const opts = model.options() as { width: number; height: number };
  const size = {
    width: opts.width > 0 ? opts.width : Math.max(0, Math.round(rect.width)),
    height: opts.height > 0 ? opts.height : Math.max(0, Math.round(rect.height)),
  };
  const liveBarSpacing = (): number =>
    (model.options() as { timeScale?: { barSpacing?: number } }).timeScale?.barSpacing ?? 6;

  // Build the host (M8) over the injected backend; it composites each pane's PaneScene
  // → backend.renderLayer per the §6 call sequence. `markInput` (profile-only) tags the
  // input→paint lag at the gesture/hover hooks (perf §4.4.9).
  host = buildHost<H>(backend, element, model, sceneFor, env?.scheduler, profiler, markInput);
  host.setSize(size); // one synchronous Layout flush → the first paint

  // The chart facade handle, assigned at the end (before any user attach call can run) so
  // a PrimitiveContext can hand `ctx.chart` to plugins (design 02 §12). Lazily read.
  let chartApi: IChart<H> | null = null;

  // --- §12 HOST PRIMITIVE BINDING (design 02 §12 + design 05 §2.2 + §9.1 slot 4) ------
  // The M8/M9 seam gap M12 exposed: attachPrimitive was inert. We now drive the full
  // lifecycle over the EXISTING views PrimitiveBinding seam — call attached(ctx), register
  // each tagged source into the owner's PaneScene, and detach EXACTLY ONCE on auto-detach
  // (removeSeries / removePane / dispose). The registry keys on the primitive identity so
  // detach is idempotent. Only `target:'pane'` sources home to an api-owned scene here; a
  // `price-axis`/`time-axis` target's destination scene is created host-side per frame
  // (buildHost's paneConfigs/measure) and is NOT reachable through this seam — those sources
  // still drive lifecycle (attached/detached fire) but are not registered (a separate seam).
  const binder = createPrimitiveBinder<H>(model);

  /** Build the §12 context handed to a primitive's attached(). `seriesHandle` is present
   *  iff series-attached. `requestUpdate(scope)` maps onto the §4.4 UpdateLevel; `images`
   *  is the sole backend upload path (§5.2); `input`/`chart` resolve lazily (post-attach). */
  const ctxFor = (pane: Pane, seriesHandle?: ISeries<SeriesType, H>): PrimitiveContext<H> => ({
    get chart(): IChart<H> {
      return chartApi!;
    },
    series: seriesHandle,
    pane: paneHandle(pane) as unknown as PrimitiveContext<H>['pane'],
    requestUpdate(scope): void {
      model.invalidate(
        scope === 'layout' ? UpdateLevel.Layout : scope === 'render' ? UpdateLevel.Render : UpdateLevel.Overlay,
      );
    },
    get input() {
      return host!.input();
    },
    images: { create: (src: unknown) => backend.createImage(src as never) },
  });

  /** The owner's CURRENT placement the PrimitiveBinding resolves a price-axis target from
   *  (the pane id + the owner's scale side). Series-attached follows the series' scale;
   *  pane-attached defaults to the right axis (doc 02 targeting rule). */
  const placementFor = (pane: Pane, scaleId: string | null): OwnerPlacement => ({
    paneId: pane.id(),
    priceScaleId: scaleId,
    axisSide: scaleId === 'left' ? 'left' : scaleId === null ? null : 'right',
  });

  // Now that the binder + ctxFor exist, populate the forward-declared pane-attach hooks.
  // A pane-attached primitive homes its sources into THIS pane's scene (sceneFor(pane));
  // its placement defaults to the right axis (doc 02 targeting rule). The owner token is
  // the model Pane, so removePane (destroyPane, below) auto-detaches its primitives once.
  panePrimitiveAttach = (pane: Pane, p: ModelIPrimitive): void => {
    binder.attach(p as unknown as IPrimitive<H>, ctxFor(pane), {
      owner: pane,
      scene: sceneFor(pane),
      ownerZ: ownerSeq, // pane primitives share the pane's base owner-z (under the series)
      ownerId: ++ownerSeq,
      placement: placementFor(pane, 'right'),
    });
  };
  panePrimitiveDetach = (p: ModelIPrimitive): void => {
    binder.detach(p as unknown as IPrimitive<H>);
  };

  const wiring: ChartWiring<H> = {
    createSeries(definition, seriesOpts, paneIndex) {
      const panes = model.panes();
      const pane = paneIndex === panes.count() ? panes.addPane() : panes.panes()[paneIndex]!;
      const w = wireSeries<H>(
        definition as SeriesDefinition<SeriesType, unknown, unknown>,
        seriesOpts,
        pane,
        model,
        timeline,
        beh,
        sceneFor(pane),
        ownerSeq,
        ++ownerSeq,
        disposed,
        size,
        paneHandle,
        priceScaleHandle,
        counters,
        binder,
        ctxFor,
        placementFor,
      );
      wired.set(w.model, w);
      pane.addSeries(w.paneSeries);
      model.invalidate(UpdateLevel.Layout);
      return { model: w.model, handle: w.handle };
    },
    destroySeries(m) {
      const w = wired.get(m);
      if (w === undefined) return;
      binder.detachOwner(m); // §2.2 item 2: auto-detach this series' primitives (once each)
      w.scene.unregister(w.source); // stop compositing it (perf §4.4.2)
      w.disposeExtras(); // unregister this series' price-line SceneSources too (§11.1)
      w.pane.removeSeries(w.paneSeries); // drop it from the model pane
      wired.delete(m);
      model.invalidate(UpdateLevel.Layout);
    },
    destroyPane(pane) {
      // §2.2 item 2: detach this pane's pane-attached primitives AND any series-attached
      // primitives on series living on it, EXACTLY ONCE each (the binder is idempotent).
      binder.detachOwner(pane);
      for (const w of wired.values()) if (w.pane === pane) binder.detachOwner(w.model);
    },
    createPane: (pane) => paneHandle(pane),
    createTimeScale: () => makeTimeScaleHandle<H>(model, behavior, disposed, liveBarSpacing),
    createPriceScale: (pane, scaleId) => priceScaleHandle(pane, scaleId),
    setCrosshairPosition: (price, horzItem, series) => {
      model.invalidate(UpdateLevel.Overlay);
      // Notify crosshairMove subscribers of the programmatic move (the multi-chart sync
      // seam, §7/§14.2): build a lazy payload keyed by the user's series handle.
      if (events.crosshairMove.hasListeners()) {
        const handle = series === null ? undefined : findHandle(wired, series);
        events.crosshairMove.emit(() => [
          {
            time: horzItem,
            paneIndex: 0,
            seriesData:
              handle && price !== null ? new Map([[handle, { value: price }]]) : new Map(),
          },
        ] as Parameters<MouseEventHandler<H>>);
      }
    },
    clearCrosshairPosition: () => model.invalidate(UpdateLevel.Overlay),
    seriesModel(handle) {
      for (const w of wired.values()) if (w.handle === handle) return w.model;
      return null;
    },
    events,
  };

  chartApi = createChartApi<H>({
    model,
    host: {
      setSize: (s) => host!.setSize(s),
      takeScreenshot: (includeCrosshair) => host!.takeScreenshot(includeCrosshair),
      input: () => host!.input(),
      dispose: () => {
        binder.detachAll(); // §2.2 item 2: detached() once for EVERY attached primitive
        host!.dispose();
        if (mount.contains(element)) mount.removeChild(element);
      },
    },
    behavior,
    wiring,
    disposed,
    element,
    barSpacing: liveBarSpacing,
  });
  return chartApi;
}

// --- createChart: the tree-shaken sugar (design 01 §8) -----------------------------
// THE ONLY backend-canvas import in `api` (§3.1 import wall — dep-cruiser enforces it).
import { canvasBackend } from '../backend-canvas';

/** createChart(c, o) ≡ createChartWith(c, canvasBackend(), timeBehavior(), o) — the
 *  default time chart over the Canvas-2D backend (design 02 §3.1). */
export function createChart(
  container: HTMLElement | string,
  options?: DeepPartial<ChartOptions>,
): IChart<Time> {
  // timeBehavior() chooses its own internal item type `I`; the core only round-trips I
  // (§13.3), so the H-only public signature erases it here (the behavior is I-opaque).
  return createChartWith<Time>(
    container,
    canvasBackend(),
    timeBehavior() as unknown as IHorzScaleBehavior<Time>,
    options,
  );
}

/** The library version (design 02 §3.1). */
export function version(): string {
  return '0.0.0';
}

export { canvasBackend, timeBehavior };

// --- container resolution (§3.1) ---------------------------------------------------

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== 'string') return container;
  // A string id resolves via document.getElementById; a miss — or no document at all
  // (headless) — is container-not-found (§3.1 / §16).
  const doc = typeof document !== 'undefined' ? document : null;
  const el = doc?.getElementById(container) ?? null;
  if (el === null) throwChartError(ChartErrorCode.ContainerNotFound, container);
  return el;
}

// --- §12 primitive binder: the attach/detach lifecycle over the views seam ----------

/** What `attach` needs to home a primitive's sources + drive its lifecycle. The `owner`
 *  token (model Series or Pane) is the key auto-detach (removeSeries/removePane) keys on. */
interface PrimitiveAttachInit {
  readonly owner: object;
  readonly scene: PaneScene;
  readonly ownerZ: number;
  readonly ownerId: number;
  readonly placement: OwnerPlacement;
}

/** One live primitive's binding state: the registered bindings (for unregister) + the
 *  PaneScene each homed to, so detach unregisters from the SAME scene + fires detached once. */
interface PrimitiveEntry {
  readonly owner: object;
  readonly scene: PaneScene;
  readonly bindings: PrimitiveBinding[];
}

/**
 * The chart-scoped primitive registry (design 02 §12 + design 05 §2.2). `attach(p, ctx,
 * init)` runs p.attached(ctx), wraps each `target:'pane'` source in a PrimitiveBinding,
 * registers it into the owner's PaneScene, and schedules one Render frame (§2.2 item 1).
 * `detachOwner`/`detachAll` fire p.detached() EXACTLY ONCE and unregister its sources
 * (§2.2 item 2); a primitive detached twice is a no-op (idempotent). A `price-axis`/
 * `time-axis` target source's destination scene is host-owned (created per frame in
 * buildHost) and not reachable here — those sources still drive lifecycle but are not
 * registered (NOTE: surfacing host axis scenes back to the api is a separate seam).
 */
function createPrimitiveBinder<H>(model: ChartModel<H, unknown>): {
  attach(p: IPrimitive<H>, ctx: PrimitiveContext<H>, init: PrimitiveAttachInit): void;
  detach(p: IPrimitive<H>): void;
  detachOwner(owner: object): void;
  detachAll(): void;
} {
  const entries = new Map<IPrimitive<H>, PrimitiveEntry>();

  const detachOne = (p: IPrimitive<H>): void => {
    const entry = entries.get(p);
    if (entry === undefined) return; // already detached — idempotent (§2.2 exactly-once)
    entries.delete(p);
    for (const b of entry.bindings) entry.scene.unregister(b.source());
    p.detached?.(); // fire the host-driven lifecycle hook EXACTLY once
    model.invalidate(UpdateLevel.Render); // the source is gone → recomposite the base layer
  };

  return {
    attach(p, ctx, init): void {
      if (entries.has(p)) return; // attached already (a re-attach is a no-op here)
      p.attached?.(ctx);
      const bindings: PrimitiveBinding[] = [];
      for (const raw of p.sources?.() ?? []) {
        const tagged = raw as unknown as TaggedPrimitiveSource; // views narrows source: unknown→SceneSource
        const binding = new PrimitiveBinding(tagged, init.placement);
        // Only a source homing to the api-owned pane scene is registered here; an axis-
        // target source resolves to a host-owned scene unreachable through this seam.
        const home: SurfaceKind | null = binding.surfaceKey();
        if (home === 'pane') init.scene.register(binding.source(), { ownerZ: init.ownerZ, ownerId: init.ownerId });
        bindings.push(binding);
      }
      entries.set(p, { owner: init.owner, scene: init.scene, bindings });
      model.invalidate(UpdateLevel.Render); // §2.2 item 1: attach schedules one Render frame
    },
    detach(p): void {
      detachOne(p); // explicit handle.detach() path — keyed on the primitive, exactly-once
    },
    detachOwner(owner): void {
      for (const [p, e] of [...entries]) if (e.owner === owner) detachOne(p);
    },
    detachAll(): void {
      for (const p of [...entries.keys()]) detachOne(p);
    },
  };
}

// --- wiring one series: data pipeline + SceneSource + the ISeries facade port -------

function wireSeries<H>(
  definition: SeriesDefinition<SeriesType, unknown, unknown>,
  options: DeepPartial<unknown> | undefined,
  pane: Pane,
  model: ChartModel<H, unknown>,
  timeline: Timeline<ItemWithTime, H, unknown>,
  behavior: IHorzScaleBehavior<H, unknown>,
  scene: PaneScene,
  ownerZ: number,
  ownerId: number,
  disposed: DisposedCell,
  size: { width: number; height: number },
  paneHandle: (pane: Pane) => IPane<H>,
  priceScaleHandle: (pane: Pane, scaleId: string) => IPriceScale,
  counters: IFrameCounters | undefined,
  binder: ReturnType<typeof createPrimitiveBinder<H>>,
  ctxFor: (pane: Pane, series?: ISeries<SeriesType, H>) => PrimitiveContext<H>,
  placementFor: (pane: Pane, scaleId: string | null) => OwnerPlacement,
): Wired<H> {
  const merged = createSeriesOptions(
    definition.defaultOptions as Record<string, unknown>,
    options as DeepPartial<Record<string, unknown>> | undefined,
    definition.normalizeOptions,
  );
  const modelSeries = new ModelSeries({
    kind: definition.type as never,
    defaultOptions: merged,
    normalizeOptions: definition.normalizeOptions,
  });

  const store = new PlotStore(definition.contract);
  const seriesId = `s${ownerId}`;
  const kind = definition.createKind(modelSeries.options() as never);
  const buffer = makeBuffer(kind);
  // perf §9.6: thread the per-frame counters into the data store (chunk recomputes) and
  // the item buffer (backing reallocs). Feature-detected (a custom-series buffer may not
  // be a ReusableItemBuffer). Strips out without __TV_PROFILE__.
  if (__TV_PROFILE__ && counters !== undefined) {
    store.setCounters(counters);
    const b = buffer as { setCounters?: (c: IFrameCounters) => void };
    if (typeof b.setCounters === 'function') b.setCounters(counters);
  }
  const builder = new DisplayListBuilder();
  let cached: readonly DisplayList[] = [];
  const dataChanged = new EventHub<[StoreDiff]>();
  const items: unknown[] = [];

  // The most recent per-frame price converter — captured so the §11.1 price-line
  // SceneSources (registered AboveSeries) can map their price → media-px y through the
  // SAME geometry the series rendered with (no separate scale ownership in the api).
  let lastPrice: ReturnType<typeof buildPriceConverter> | null = null;

  const rebuild = (frame: ViewFrame): void => {
    if (store.length === 0) {
      cached = [];
      return;
    }
    const win = itemWindow(0, store.length);
    const horz = buildHorzGeometry({
      width: frame.frame.mediaSize.width || size.width || 100,
      barSpacing: 6,
      rightOffset: 0,
      baseIndex: store.length - 1,
    });
    const price = priceConverterFor(store, frame.frame.mediaSize.height || size.height || 100);
    lastPrice = price;
    kind.itemsFromStore(store as PlotStoreView, { kind: 'replace' }, buffer);
    kind.convert(buffer, win, frame, horz, price);
    builder.reset();
    kind.emit(buffer, win, frame, builder);
    cached = builder.finish();
  };

  const source: SceneSource = {
    zBand: ZBand.Series,
    update: rebuild,
    displayLists: () => cached,
    hitTest: (x: Coordinate, y: Coordinate) => kind.hitTest(buffer, x, y),
  };
  scene.register(source, { ownerZ, ownerId });
  const paneSeries = { kind: () => modelSeries.kind() }; // the model PaneSeries (removeSeries drops it)

  const setData = (next: readonly unknown[]): void => {
    items.length = 0;
    for (const it of next) items.push(it);
    const applied = timeline.applySeriesData(seriesId, next as readonly ItemWithTime[], behavior);
    const rows = applied.rows.map((r) => r.item);
    const idx = applied.rows.map((r) => r.timeIndex as unknown as number);
    const diff = store.setData(rows, idx);
    modelSeries.applyDiff(store as PlotStoreView, diff);
    rebuild(frameFor(size));
    model.invalidate(UpdateLevel.Render);
    if (dataChanged.hasListeners()) dataChanged.emit(() => [{ kind: 'replace' }]);
  };

  // §11.1 price lines: one cached IPriceLine per createPriceLine call; removePriceLine
  // kills it (its port reports !isAlive → the handle's methods then throw). M11 parity:
  // each line also registers a price-line SceneSource (band AboveSeries) into THIS pane's
  // scene, so the horizontal line actually paints — closing the M9 rendering deferral.
  interface PriceLineEntry {
    readonly handle: IPriceLine;
    readonly source: PriceLineSource;
    kill(): void;
  }
  const priceLineEntries = new Set<PriceLineEntry>();
  const lineToEntry = new Map<IPriceLine, PriceLineEntry>();

  const port: SeriesPort<H> = {
    isDisposed: () => disposed.value,
    setData,
    update: (item) => setData([...items, item]),
    data: () => items.slice(),
    dataByIndex: () => null,
    barsInLogicalRange: () => null,
    store: () => store as PlotStoreView,
    priceToCoordinate: () => null,
    coordinateToPrice: () => null,
    priceFormatter: () => ({ format: (p: number) => String(p) }),
    priceScale: () => priceScaleHandle(pane, scaleIdOf(modelSeries)), // §2: the chart's cached handle
    pane: () => paneHandle(pane), // §2: the chart's cached pane handle (=== chart.panes()[i])
    moveToPane: () => {},
    order: () => 0,
    setOrder: () => {},
    optionsChanged: () => model.invalidate(UpdateLevel.Render),
    createPriceLine: (lineOpts) => {
      let alive = true;
      let stored = lineOpts;
      const handle = createPriceLineApi({
        port: {
          isDisposed: () => disposed.value,
          isAlive: () => alive,
          applyOptions: (patch) => {
            stored = { ...stored, ...(patch as object) } as PriceLineOptions;
            // The price line is an AboveSeries (BASE-layer) source — a change must
            // recomposite the base layer, which only a Render frame repaints (an Overlay
            // frame paints the overlay layer only). So invalidate at Render (§4.4).
            model.invalidate(UpdateLevel.Render);
          },
          options: () => snapshot(stored),
        },
      });
      // M9 deferral closed: register the views price-line SceneSource (AboveSeries)
      // so the line paints. `provider` maps the stored price through the SAME
      // per-frame converter the series rendered with (lastPrice); a null converter
      // (no data yet) hides the line.
      const provider = (): PriceLineState => {
        const y = lastPrice !== null ? lastPrice.priceToCoordinate(stored.price) : null;
        return {
          y: y !== null && Number.isFinite(y) ? y : null,
          barColor: modelSeries.priceLineColor(), // §4.13 fallback target: series priceLineColor/base color
          text: stored.title ?? '',
        };
      };
      const source = createPriceLineSource(provider, {
        visible: stored.lineVisible ?? true,
        color: stored.color ?? '',
        lineWidth: stored.lineWidth ?? 1,
        // NOTE: public PriceLineOptions.lineStyle is a string ('dashed'…) but the source
        // wants the gfx numeric LineStyle; honoring it needs a string→LineStyle boundary
        // normalization that does not exist yet (affects ALL kinds, not just price lines).
        // Deferred — the source defaults to Dashed (§4.13 default) meanwhile.
        externalId: stored.id,
      });
      scene.register(source, { ownerZ, ownerId });
      const entry: PriceLineEntry = {
        handle,
        source,
        kill: (): void => {
          alive = false;
          scene.unregister(source);
          model.invalidate(UpdateLevel.Render); // base-layer recomposite (§4.4)
        },
      };
      priceLineEntries.add(entry);
      lineToEntry.set(handle, entry);
      model.invalidate(UpdateLevel.Render); // base-layer recomposite so the new line paints
      return handle;
    },
    removePriceLine: (line) => {
      const entry = lineToEntry.get(line);
      if (entry === undefined) return;
      entry.kill();
      priceLineEntries.delete(entry);
      lineToEntry.delete(line);
    },
    priceLines: () => [...priceLineEntries].map((e) => e.handle),
    lastValue: () => {
      const lv = modelSeries.lastValue();
      return lv === null ? null : { price: lv.price, color: '' };
    },
    dataChanged,
  };

  const handle = createSeriesApi<SeriesType, H>(
    definition.type,
    modelSeries,
    port,
    definition.normalizeOptions,
  );

  // §12 host binding for SERIES-attached primitives: the series facade calls
  // model.attachPrimitive(p) (which still pushes to the model #primitives list the
  // autoscale merge reads); we wrap the instance methods so the SAME call ALSO drives
  // the host lifecycle — attached(ctx) + source registration into THIS pane's scene +
  // a Render frame, and detach fires detached() exactly once (the auto-detach path is
  // destroySeries → binder.detachOwner(modelSeries), below). The placement follows the
  // series' current scale (its price-axis sources home to that side).
  // `p` infers as the MODEL IPrimitive (the contextual type of the method we override);
  // the binder works in the api IPrimitive<H> (the host-lifecycle superset), so cast at
  // the boundary. baseAttach keeps the model #primitives push the autoscale merge reads.
  const baseAttach = modelSeries.attachPrimitive.bind(modelSeries);
  const baseDetach = modelSeries.detachPrimitive.bind(modelSeries);
  modelSeries.attachPrimitive = (p): void => {
    baseAttach(p);
    binder.attach(p as unknown as IPrimitive<H>, ctxFor(pane, handle), {
      owner: modelSeries,
      scene,
      ownerZ,
      ownerId,
      placement: placementFor(pane, scaleIdOf(modelSeries)),
    });
  };
  modelSeries.detachPrimitive = (p): void => {
    baseDetach(p); // drop it from the model #primitives list (autoscale stops merging it)
    binder.detach(p as unknown as IPrimitive<H>); // host lifecycle: detached() + unregister, once
  };

  const disposeExtras = (): void => {
    for (const e of priceLineEntries) scene.unregister(e.source);
    priceLineEntries.clear();
    lineToEntry.clear();
  };
  return { model: modelSeries, handle, pane, scene, source, paneSeries, disposeExtras };
}

function scaleIdOf(s: ModelSeries): string {
  return (s.options() as { priceScaleId?: string }).priceScaleId ?? 'right';
}

function frameFor(size: { width: number; height: number }): ViewFrame {
  const w = size.width || 100;
  const h = size.height || 100;
  return { frame: { mediaSize: { width: w, height: h }, bitmapSize: { width: w, height: h }, hr: 1, vr: 1 }, now: 0 };
}

// A reusable ItemBuffer for a kind. Line/baseline/histogram/bar/candlestick expose
// createBuffer(); area ships its buffer with the kind; defineSeries authors supply one.
function makeBuffer(kind: SeriesKind<unknown>): ItemBuffer<unknown> {
  const factory = (kind as { createBuffer?: () => ItemBuffer<unknown> }).createBuffer;
  if (typeof factory === 'function') return factory.call(kind);
  const ship = (kind as { buffer?: ItemBuffer<unknown> }).buffer;
  return ship ?? ({ length: 0 } as unknown as ItemBuffer<unknown>);
}

// A PriceConverter spanning the store's value range over the pane height. A full chart
// derives this from the price-scale autoscale; here it bounds the data so emit makes
// in-range geometry (the backend stream is what the e2e gates on).
// DEFERRED (M12): feeding the attached primitives' autoscale MARGINS (max-merged correctly
// at the model level — Series.#baseAutoscaleInfo §9.2.3) into this LIVE geometry would
// shift demo-chart's golden, so priceConverterFor is left as-is; primitive-margin-into-
// live-geometry is a separate seam (the real price-scale autoscale path) for a later milestone.
function priceConverterFor(store: PlotStoreView, height: number): ReturnType<typeof buildPriceConverter> {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < store.length; i++) {
    if (store.min(i) < min) min = store.min(i);
    if (store.max(i) > max) max = store.max(i);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) (min = 0), (max = 1);
  return buildPriceConverter({
    height: height > 0 ? height : 100,
    range: { min, max },
    scaleMargins: { top: 0.1, bottom: 0.1 },
    marginAbovePx: 0,
    marginBelowPx: 0,
    mode: PriceScaleMode.Normal,
    inverted: false,
    firstValue: min,
  });
}

// --- the sibling-handle factories (the §2 cached handles the chart returns) ---------

function makePaneHandle<H>(
  pane: Pane,
  model: ChartModel<H>,
  disposed: DisposedCell,
  priceScaleHandle: (pane: Pane, scaleId: string) => IPriceScale,
  attachPrimitive: (p: ModelIPrimitive) => void,
  detachPrimitive: (p: ModelIPrimitive) => void,
): IPane<H> {
  const port: PanePort<H> = {
    isDisposed: () => disposed.value,
    index: () => model.panes().indexOf(pane),
    id: () => pane.id(),
    size: () => ({ width: 0, height: 0 }),
    height: () => 0,
    setHeight: () => {},
    stretchFactor: () => pane.stretchFactor(),
    setStretchFactor: (f) => pane.setStretchFactor(f),
    moveTo: (index) => {
      model.panes().moveTo(pane, index);
      model.invalidate(UpdateLevel.Layout);
    },
    series: () => pane.series().map((s) => ({ seriesType: () => s.kind() })),
    priceScale: (id) => (pane.priceScale(id) === null ? null : priceScaleHandle(pane, id)), // §2 cached

    addSeries: () => throwChartError(ChartErrorCode.UnknownSeriesDefinition),
    preserveEmptyPane: () => pane.preserveEmptyPane(),
    setPreserveEmptyPane: (keep) => pane.setPreserveEmptyPane(keep),
    element: () => null,
    attachPrimitive, // §12: drive the host binding (was a no-op — the M12 seam gap)
    detachPrimitive,
  };
  return createPaneApi<H>(port) as unknown as IPane<H>;
}

function makePriceScaleHandle(
  pane: Pane,
  scaleId: string,
  disposed: DisposedCell,
): { handle: IPriceScale; alive: () => boolean } {
  // §10: once the model scale is gone the handle latches DEAD one-way — a re-created id
  // (resolved by the chart's cache) mints a fresh handle; this one never revives.
  let dead = false;
  const alive = (): boolean => {
    if (dead) return false;
    if (pane.priceScale(scaleId) === null) dead = true;
    return !dead;
  };
  const port: PriceScalePort = {
    isDisposed: () => disposed.value,
    isAlive: alive,
    isEmpty: () => (pane.priceScale(scaleId)?.range() ?? null) === null,
    id: () => scaleId,
    applyOptions: (patch) => pane.priceScale(scaleId)?.applyOptions(patch),
    options: () => pane.priceScale(scaleId)!.options() as never,
    width: () => 0,
    getVisibleRange: () => null,
    setVisibleRange: () => {},
    autoScaleActive: () => pane.priceScale(scaleId)?.isAutoScale() ?? true,
  };
  return { handle: createPriceScaleApi({ port }) as unknown as IPriceScale, alive };
}

function makeTimeScaleHandle<H>(
  model: ChartModel<H>,
  behavior: IHorzScaleBehavior<H>,
  disposed: DisposedCell,
  barSpacing: () => number,
): ITimeScale<H> {
  return createTimeScaleApi<H>({
    port: {
      isDisposed: () => disposed.value,
      isEmpty: () => true,
      key: (item) => behavior.key(item) as unknown as number,
      scrollPosition: () => 0,
      scrollToPosition: () => {},
      scrollToRealTime: () => {},
      fitContent: () => model.invalidate(UpdateLevel.Render),
      reset: () => model.invalidate(UpdateLevel.Render),
      getVisibleRange: () => null,
      setVisibleRange: () => {},
      getVisibleLogicalRange: () => null,
      setVisibleLogicalRange: () => {},
      logicalToCoordinate: () => null,
      coordinateToLogical: () => null,
      snapToBar: () => null,
      timeToCoordinate: () => null,
      coordinateToTime: () => null,
      timeToLogical: () => null,
      keyToLogical: () => null,
      logicalToKey: () => null,
      keysInRange: () => [],
      barSpacing,
      rightOffset: () => 0,
      width: () => 0,
      height: () => 0,
      events: {
        visibleTimeRange: new EventHub<[TimeRange<H> | null]>(),
        visibleLogicalRange: new EventHub<[LogicalRange | null]>(),
        size: new EventHub<[number, number]>(),
      },
    },
    applyOptions: (patch) => model.applyOptions({ timeScale: patch } as DeepPartial<ChartOptions>),
    options: () => (model.options() as unknown as { timeScale: never }).timeScale,
  });
}

// --- building the host (M8) over the injected backend ------------------------------

function buildHost<H>(
  backend: IRenderBackend,
  element: HTMLElement,
  model: ChartModel<H>,
  sceneFor: (pane: Pane) => PaneScene,
  schedulerOverride?: IFrameScheduler,
  profiler?: FrameProfiler,
  markInput: () => void = () => {},
): ChartHost {
  // The default rAF env (window in prod; tests inject env.scheduler so this never runs).
  const scheduler =
    schedulerOverride ??
    createRafScheduler({
      requestAnimationFrame: (cb) => globalThis.requestAnimationFrame(cb),
      cancelAnimationFrame: (h) => globalThis.cancelAnimationFrame(h),
    });
  const doc = element.ownerDocument ?? document;
  const newScene = (): PaneScene => new PaneScene();

  const elements: ElementFactory = {
    root: () => element as unknown as HostElement,
    surfaceMount: () => doc.createElement('div') as unknown as HostElement,
    separator: () => doc.createElement('div') as unknown as HostElement,
  };

  const hooks: ChartHostHooks = {
    paneConfigs: (): readonly PaneSurfaceConfigs[] =>
      model.panes().panes().map((pane) => ({
        pane: { kind: 'pane', scene: sceneFor(pane) },
        leftAxis: { kind: 'price-axis', scene: newScene() },
        rightAxis: { kind: 'price-axis', scene: newScene() },
      })),
    measure: (): MeasuredAxes => ({
      axisWidths: { left: 0, right: 60 },
      timeAxisHeight: 28,
      timeAxis: { kind: 'time-axis', scene: newScene() },
      leftStub: { kind: 'time-axis', scene: newScene() },
      rightStub: { kind: 'time-axis', scene: newScene() },
    }),
    syncWidgets: () => {},
    applyRender: () => {},
    animationRearmLevel: () => UpdateLevel.None,
    applyHover: () => false,
    clearHover: () => false,
    // Each gesture intent marks the input→paint lag (profile-only, perf §4.4.9) before
    // arming the Render frame the lag is measured against.
    pan: () => (markInput(), model.invalidate(UpdateLevel.Render)),
    zoom: () => (markInput(), model.invalidate(UpdateLevel.Render)),
    resetPane: () => (markInput(), model.invalidate(UpdateLevel.Render)),
    priceAxisDrag: () => (markInput(), model.invalidate(UpdateLevel.Render)),
  };

  return new ChartHost({
    model: model as never,
    backend: backend as never,
    elements,
    scheduler,
    clock: () => 0,
    hooks,
    getDpr: () => 1,
    profiler: __TV_PROFILE__ ? profiler : undefined,
  });
}

/** Resolve the public ISeries handle backing a model Series, or undefined when foreign. */
function findHandle<H>(wired: Map<ModelSeries, Wired<H>>, m: ModelSeries): ISeries<SeriesType, H> | undefined {
  return wired.get(m)?.handle;
}

