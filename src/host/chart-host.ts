// traderzview · host/chart-host — the ROOT host (architecture §7). Owns: the root
// <div> (position:relative, overflow:hidden — NO <table>), the surface tree (a
// SurfaceHost per pane / price-axis / time-axis / stub) with 1-px separators,
// computeLayout → surface-size wiring (model width applied LAST, study 10 §3.1), the
// per-chart FrameLoop, the gesture machine → InteractionRouter → default pan/zoom/
// crosshair behaviors, and the hover flow (pointer-move → views hit-test → model
// crosshair.setHover → Overlay, §5.5). Takes an IRenderBackend BY INJECTION — it
// never imports a concrete backend (§3.1). Auto-size + Hi-DPI per §7.
import type { Rect, Size } from '../core';
import type { Snapshot } from '../gfx';
import type { ChartModel, UpdateMask } from '../model';
// The host touches the model only through `panes()` (pane count + stretch factors);
// H/I generics never reach it, so the dep is the generic-free slice — a
// `ChartModel<Time, …>` satisfies it without infecting ChartHost with H/I.
type HostModel = Pick<ChartModel, 'panes'>;
import { UpdateLevel, createMask } from '../model';
import { computeLayout, type AxisWidths, type LayoutRects } from './layout';
import { FrameLoop, type FrameDriver, type FrameProfiler, type IFrameScheduler } from './frame-scheduler';
import { InteractionRouter } from './input/router';
import { GestureMachine, type GesturePointer } from './input/gestures';
import type { GestureEvent, SurfaceKind } from './input/types';
import { registerDefaultBehaviors, type DefaultBehaviorPorts } from './input/behaviors';
import { attachDomInput, type DomInputTarget, type WheelIntent } from './input/dom-input';
import type { Unsubscribe, Coordinate } from '../core';
import { captureScreenshot, type SnapshotComposer } from './screenshot';
import { SurfaceHost, type HostElement, type SurfaceConfig, type SurfaceFactory } from './surface-host';

/** Creates the DOM nodes the host positions. `HTMLElement` satisfies `HostElement`;
 *  a headless test passes fakes that record style writes (no real document). */
export interface ElementFactory {
  /** The root container element (already mounted in the user's page). */
  root(): HostElement;
  /** A child mount div for a surface (the backend creates canvases into it). */
  surfaceMount(): HostElement;
  /** A 1-px separator div between panes (surface-less DOM chrome). */
  separator(): HostElement;
}

/** The backend, narrowed to exactly what the host calls (surface creation + the
 *  screenshot compositor). The concrete IRenderBackend satisfies this structurally,
 *  so the host never names a backend type (§3.1 import wall). */
export type HostBackend = SurfaceFactory & SnapshotComposer;

/**
 * The model/views per-frame work the host drives but does not own (§3.1: the host
 * touches the DOM; views compute scenes/hit-tests; the model owns autoscale/geometry).
 * The api layer wires these to `views`/`model`; tests pass recording fakes. Keeping
 * them injected is what makes ChartHost headless-testable.
 */
export interface ChartHostHooks {
  /** Per-pane SurfaceConfig (scene + kind) for the surface tree, top→bottom. The host
   *  builds left-axis / pane / right-axis SurfaceHosts from each, plus time-axis/stubs. */
  paneConfigs(): readonly PaneSurfaceConfigs[];
  /** Measured axis dims for `computeLayout` (the views axis-layout pass, §5.4). */
  measure(): MeasuredAxes;
  /** Layout step (§4.4): reconcile the widget/source tree to the model panes. */
  syncWidgets(): void;
  /** Render step (§4.4): momentary autoscale + horz-command replay + axis models. */
  applyRender(mask: UpdateMask, now: number): void;
  /** Unfinished-animation level for the next frame (None / Overlay / Render, §4.4). */
  animationRearmLevel(now: number): UpdateLevel;
  /** Resolve a pointer at media (x,y) over a pane to a HoverTarget and apply it to the
   *  model crosshair (views hit-test → crosshair.setHover, §5.5). Returns true when the
   *  hover state changed (so the host raises an Overlay frame). */
  applyHover(paneIndex: number, x: number, y: number, now: number): boolean;
  /** Clear the crosshair hover (pointer left every pane). True when state changed. */
  clearHover(): boolean;
  /** Pan the time scale by a media-px horizontal delta (drag/wheel-scroll, §4.6). */
  pan(deltaXpx: number): void;
  /** Zoom the time scale by a ±-step around media x (wheel/time-axis drag, §13.5). */
  zoom(step: number, atX: number): void;
  /** Reset the pane (fit time scale + autoscale) on double-click (§10). */
  resetPane(paneIndex: number): void;
  /** Drag the price axis of a pane by a media-px vertical delta (axis scale, §4.6). */
  priceAxisDrag(paneIndex: number, deltaYpx: number, axis: 'left' | 'right'): void;
  /** Scroll the pane's price scale by a media-px vertical delta (pane-body drag, §4.6). */
  priceScroll(paneIndex: number, deltaYpx: number): void;
}

/** The three surface configs of one pane row (left axis may be absent ⇒ width 0). */
export interface PaneSurfaceConfigs {
  readonly pane: SurfaceConfig;
  readonly leftAxis: SurfaceConfig;
  readonly rightAxis: SurfaceConfig;
}

/** Measured axis dimensions in media px (0 ⇒ that surface is omitted, per layout). */
export interface MeasuredAxes {
  readonly axisWidths: AxisWidths;
  readonly timeAxisHeight: number;
  readonly timeAxis: SurfaceConfig;
  readonly leftStub: SurfaceConfig;
  readonly rightStub: SurfaceConfig;
}

export interface ChartHostDeps {
  readonly model: HostModel;
  readonly backend: HostBackend;
  readonly elements: ElementFactory;
  readonly scheduler: IFrameScheduler;
  readonly clock: () => number;
  readonly hooks: ChartHostHooks;
  /** Device pixel ratio source (window.devicePixelRatio in prod; a fake in tests). */
  readonly getDpr: () => number;
  /** User-facing wheel-speed multiplier (architecture §7; defaults 1). */
  readonly wheelSpeed?: number;
  /** Chromium-on-Windows PIXEL ÷DPR wheel correction (§7; the api detects it). */
  readonly windowsChromium?: boolean;
  /** 1-px pane-separator fill color for screenshots (study 01 §3.7). */
  readonly separatorColor?: string;
  /** __TV_PROFILE__-only bench instrumentation (perf §9.6): the per-frame counters +
   *  IPerfSink the frame loop resets/reads/emits. Undefined (and stripped) otherwise. */
  readonly profiler?: FrameProfiler;
}

// One pane row's surface widgets + the separator above it (null for the first pane).
interface PaneRow {
  readonly pane: SurfaceHost;
  readonly leftAxis: SurfaceHost;
  readonly rightAxis: SurfaceHost;
  readonly separator: HostElement | null;
}

/**
 * The root host. Constructed with a model + an injected backend; builds the surface
 * tree, the frame loop, and the input pipeline. `requestedSize` drives auto-size
 * (the api layer feeds it from a ResizeObserver); `invalidate` is the model's one
 * invalidation callback (the api wires `ChartModel.invalidate` to it).
 */
export class ChartHost implements FrameDriver {
  readonly #deps: ChartHostDeps;
  readonly #root: HostElement;
  readonly #loop: FrameLoop;
  readonly #router = new InteractionRouter();
  readonly #machines = new Map<number, GestureMachine>(); // one per surface, keyed by paneIndex*4+kind
  readonly #domUnsubs: Unsubscribe[] = []; // one DOM-input adapter teardown per surface (§7)
  readonly #rows: PaneRow[] = [];
  #timeAxis: SurfaceHost | null = null;
  #leftStub: SurfaceHost | null = null;
  #rightStub: SurfaceHost | null = null;
  #requested: Size = { width: 0, height: 0 };
  #layout: LayoutRects | null = null;
  #disposed = false;

  constructor(deps: ChartHostDeps) {
    this.#deps = deps;
    this.#root = deps.elements.root();
    const s = this.#root.style;
    s.position = 'relative';
    this.#loop = new FrameLoop(deps.scheduler, this, __TV_PROFILE__ ? deps.profiler : undefined);
    this.#buildTree();
    registerDefaultBehaviors(this.#router, this.#behaviorPorts());
  }

  /** The interaction router (chart.input() / PrimitiveContext.input, §9.1). */
  input(): InteractionRouter {
    return this.#router;
  }

  /** The model's one invalidation callback target (the api wires the model to this). */
  invalidate(mask: UpdateMask): void {
    this.#loop.invalidate(mask);
  }

  /** Set the requested outer size + auto-size (ResizeObserver, §7). The repaint is a
   *  SYNCHRONOUS forced Layout flush inside the callback (anti-jitter, study 05 §3.8):
   *  no visible one-frame lag between the container and the canvas. */
  setSize(size: Size): void {
    if (this.#disposed) return;
    this.#requested = { width: size.width, height: size.height };
    this.#loop.flushSync(createMask({ level: UpdateLevel.Layout }), this.#deps.clock());
  }

  // --- FrameDriver (the frame work the loop drives, §6 call sequence) -------------

  syncWidgets(): void {
    this.#deps.hooks.syncWidgets();
    this.#reconcileRows();
  }

  computeLayout(): void {
    const m = this.#deps.hooks.measure();
    // One stretch factor per surface ROW (the tree the host actually built). Pull the
    // per-pane stretch from the model by position where present; default 1 otherwise,
    // so the layout pane count always matches the surface tree (study 10 §3.1).
    const modelPanes = this.#deps.model.panes().panes();
    const n = Math.max(this.#rows.length, 1);
    const stretch: number[] = [];
    for (let i = 0; i < n; i++) stretch.push(modelPanes[i]?.stretchFactor() ?? 1);
    this.#layout = computeLayout(this.#requested, stretch, m.axisWidths, m.timeAxisHeight, this.#deps.getDpr());
  }

  applySizes(): void {
    const L = this.#layout;
    if (L === null) return;
    // Apply every surface rect; absent axis/stub/time surfaces resolve to a 0-area
    // rect (hidden). Model width (pane.width) is set as PART of each pane rect — it is
    // the LAST thing computeLayout produced, so applying the pane rect honors §3.1 step 7.
    for (let i = 0; i < this.#rows.length; i++) {
      const row = this.#rows[i]!;
      const pr = L.panes[i];
      row.pane.setRect(pr?.pane ?? ZERO);
      row.leftAxis.setRect(pr?.leftAxis ?? ZERO);
      row.rightAxis.setRect(pr?.rightAxis ?? ZERO);
      if (row.separator !== null) this.#placeSeparator(row.separator, L.separators[i - 1] ?? ZERO);
    }
    this.#timeAxis?.setRect(L.timeAxis ?? ZERO);
    this.#leftStub?.setRect(L.leftStub ?? ZERO);
    this.#rightStub?.setRect(L.rightStub ?? ZERO);
  }

  applyRender(mask: UpdateMask, now: number): void {
    this.#deps.hooks.applyRender(mask, now);
  }

  paint(level: UpdateLevel, now: number): void {
    if (level === UpdateLevel.None) return;
    for (const sh of this.#allSurfaces()) sh.paint(level, now);
  }

  animationRearmLevel(now: number): UpdateLevel {
    return this.#deps.hooks.animationRearmLevel(now);
  }

  // --- input: forward pointer events to the per-surface gesture machine ------------

  /** Forward a pointer event to the gesture machine of the surface at `paneIndex`/
   *  `kind`. The api layer attaches Pointer-Event listeners on the root and calls
   *  these; tests call them directly with plain GesturePointer objects. */
  pointerDown(paneIndex: number, kind: SurfaceKind, p: GesturePointer): void {
    this.#machineFor(paneIndex, kind)?.pointerDown(p);
  }
  pointerMove(paneIndex: number, kind: SurfaceKind, p: GesturePointer): void {
    this.#machineFor(paneIndex, kind)?.pointerMove(p);
  }
  pointerUp(paneIndex: number, kind: SurfaceKind, p: GesturePointer): void {
    this.#machineFor(paneIndex, kind)?.pointerUp(p);
  }
  pointerCancel(paneIndex: number, kind: SurfaceKind, p: GesturePointer): void {
    this.#machineFor(paneIndex, kind)?.pointerCancel(p);
  }

  /** Pump every gesture machine's clock once per frame (fires the 240 ms long-press). */
  tickGestures(): void {
    for (const m of this.#machines.values()) m.tick();
  }

  /** Take a screenshot: a synchronous flush, then a single-pass tile collection over
   *  the known rects → backend.composeSnapshot (§7). `includeCrosshair` (default true)
   *  is forwarded to the collector → compositor: when false the overlay layer (the
   *  crosshair/cursor/overlay bands) is omitted from the composite (§8.6). */
  takeScreenshot(includeCrosshair = true): Snapshot {
    this.#loop.flushSync(createMask({ level: UpdateLevel.Render }), this.#deps.clock());
    const L = this.#layout ?? this.computeLayoutNow();
    return captureScreenshot(
      this.#deps.backend,
      [...this.#allSurfaces()],
      L.separators,
      this.#deps.separatorColor ?? '#e0e3eb',
      L.chartSize,
      includeCrosshair,
    );
  }

  /** Cancel the pending frame, dispose the router (cancels any in-flight stream), and
   *  drop every surface (chart.dispose path). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loop.dispose();
    this.#router.dispose();
    for (const u of this.#domUnsubs) u(); // detach every surface's DOM-input listeners (§7)
    this.#domUnsubs.length = 0;
    for (const sh of this.#allSurfaces()) sh.dispose();
    this.#rows.length = 0;
  }

  // --- internals -------------------------------------------------------------------

  computeLayoutNow(): LayoutRects {
    this.computeLayout();
    return this.#layout!;
  }

  // The gesture sink: dispatch every recognized phase to the router, and run the
  // once-per-frame hover resolution for 'hover' fires on a pane (§5.5).
  #onGesture = (e: GestureEvent): void => {
    if (e.kind === 'hover' && e.surface === 'pane') {
      const changed = this.#deps.hooks.applyHover(e.paneIndex, e.x, e.y, this.#deps.clock());
      if (changed) this.#loop.invalidate(createMask({ level: UpdateLevel.Overlay }));
      return; // hover is host-internal; it is not a router gesture
    }
    this.#router.dispatch(e);
  };

  #behaviorPorts(): DefaultBehaviorPorts {
    const h = this.#deps.hooks;
    return {
      pan: (dx) => h.pan(dx),
      zoom: (step, atX) => h.zoom(step, atX),
      resetPane: (i) => h.resetPane(i),
      priceAxisDrag: (i, dy, axis) => h.priceAxisDrag(i, dy, axis),
      priceScroll: (i, dy) => h.priceScroll(i, dy),
      clearHover: () => {
        if (h.clearHover()) this.#loop.invalidate(createMask({ level: UpdateLevel.Overlay }));
      },
    };
  }

  #buildTree(): void {
    const configs = this.#deps.hooks.paneConfigs();
    for (let i = 0; i < configs.length; i++) this.#rows.push(this.#buildRow(configs[i]!, i));
    const m = this.#deps.hooks.measure();
    const f = this.#deps.elements;
    this.#timeAxis = this.#mkSurface(f.surfaceMount(), m.timeAxis, -1);
    this.#leftStub = this.#mkSurface(f.surfaceMount(), m.leftStub, -1);
    this.#rightStub = this.#mkSurface(f.surfaceMount(), m.rightStub, -1);
  }

  #buildRow(c: PaneSurfaceConfigs, index: number): PaneRow {
    const f = this.#deps.elements;
    const sep = index > 0 ? f.separator() : null;
    if (sep !== null) {
      this.#root.appendChild(sep);
      sep.style.position = 'absolute';
    }
    return {
      pane: this.#mkSurface(f.surfaceMount(), c.pane, index),
      leftAxis: this.#mkSurface(f.surfaceMount(), c.leftAxis, index),
      rightAxis: this.#mkSurface(f.surfaceMount(), c.rightAxis, index),
      separator: sep,
    };
  }

  #mkSurface(mount: HostElement, config: SurfaceConfig, paneIndex: number): SurfaceHost {
    this.#root.appendChild(mount);
    // §7: a per-surface cursor hint — the price axis scales (ns-resize), the time axis zooms
    // (ew-resize), the pane shows the crosshair. `style` is a plain record on a headless fake.
    mount.style.cursor =
      config.kind === 'price-axis' ? 'ns-resize' : config.kind === 'time-axis' ? 'ew-resize' : 'crosshair';
    const sh = new SurfaceHost(
      mount,
      this.#deps.backend,
      config,
      this.#onResolutionChange,
      __TV_PROFILE__ ? this.#deps.profiler : undefined,
    );
    // One gesture machine per interactive surface (the recognizer that feeds the router).
    const machine = new GestureMachine(
      { surface: config.kind, paneIndex },
      this.#deps.clock,
      this.#onGesture,
    );
    this.#machines.set(this.#machineKey(paneIndex, config.kind), machine);
    // §7: attach the DOM Pointer-Events + wheel adapter that FEEDS this machine from a
    // real browser. Coords are localized to this surface's content origin (the mount's
    // box) so the gesture/hover/geometry path stays surface-local. Feature-detected so a
    // headless fake mount (no addEventListener) simply gets no live input (tests call the
    // pointerDown/Move/Up forwards directly).
    const dom = mount as unknown as Partial<DomInputTarget>;
    if (typeof dom.addEventListener === 'function') {
      this.#domUnsubs.push(
        attachDomInput(
          dom as DomInputTarget,
          machine,
          (intent) => this.#onWheel(config.kind, paneIndex, intent),
          () => {
            const r = mount.getBoundingClientRect();
            return { left: r.left, top: r.top };
          },
          {
            wheelSpeed: this.#deps.wheelSpeed,
            windowsChromium: this.#deps.windowsChromium,
            getDpr: this.#deps.getDpr,
          },
        ),
      );
    }
    return sh;
  }

  // The wheel path (§7): the machine does NOT recognize wheel — the adapter normalizes
  // it (study 10 §4.4) and the host builds the discrete 'wheel' GestureEvent here, then
  // routes it through the SAME #onGesture sink the recognized gestures use, so the §9.1
  // wheel behavior (zoom + scroll) claims it. `wheelDeltaX/Y` are the post-normalization
  // scroll/zoom the behaviors read; ctrl+vertical folds into the zoom leg (§13.5).
  #onWheel(kind: SurfaceKind, paneIndex: number, intent: WheelIntent): void {
    const zoom = intent.ctrlKey && intent.zoom === 0 ? 0 : intent.zoom;
    const e: GestureEvent = {
      kind: 'wheel',
      phase: 'fire',
      surface: kind,
      paneIndex,
      x: intent.x as Coordinate,
      y: intent.y as Coordinate,
      startX: intent.x as Coordinate,
      startY: intent.y as Coordinate,
      deltaX: 0,
      deltaY: 0,
      wheelDeltaX: intent.scroll,
      wheelDeltaY: zoom,
      pointerType: 'mouse',
      modifiers: { ctrl: intent.ctrlKey, alt: false, shift: false, meta: false },
    };
    this.#onGesture(e);
  }

  // A new suggested bitmap size → one coalescing Layout mask (§5.1.6).
  #onResolutionChange = (): void => {
    this.#loop.invalidate(createMask({ level: UpdateLevel.Layout }));
  };

  #machineKey(paneIndex: number, kind: SurfaceKind): number {
    const k = kind === 'pane' ? 0 : kind === 'price-axis' ? 1 : 2;
    return (paneIndex + 1) * 4 + k;
  }

  #machineFor(paneIndex: number, kind: SurfaceKind): GestureMachine | undefined {
    return this.#machines.get(this.#machineKey(paneIndex, kind));
  }

  // Reconcile the row count to the model panes (add/remove on structural change). The
  // hooks own scene/source membership; here we only ensure one row per model pane.
  #reconcileRows(): void {
    const want = this.#deps.model.panes().count();
    while (this.#rows.length > want) {
      const row = this.#rows.pop()!;
      row.pane.dispose();
      row.leftAxis.dispose();
      row.rightAxis.dispose();
      if (row.separator !== null) this.#root.removeChild(row.separator);
    }
    // Growth is driven by paneConfigs at build time; the api re-builds on add (a model
    // pane addition fires Layout, and the hooks supply a config for the new row).
  }

  #placeSeparator(sep: HostElement, rect: Rect): void {
    const s = sep.style;
    s.left = `${rect.x}px`;
    s.top = `${rect.y}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
  }

  *#allSurfaces(): IterableIterator<SurfaceHost> {
    for (const row of this.#rows) {
      yield row.pane;
      yield row.leftAxis;
      yield row.rightAxis;
    }
    if (this.#timeAxis !== null) yield this.#timeAxis;
    if (this.#leftStub !== null) yield this.#leftStub;
    if (this.#rightStub !== null) yield this.#rightStub;
  }
}

const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0 };
