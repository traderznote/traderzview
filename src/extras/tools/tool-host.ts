// traderzview · extras/tools — the drawing-tool host (design 05 §4; proves V1-REQ
// T1–T8). createToolHost(chart) is the creation/edit FSM idle→armed→placing→committed,
// registered on the chart's InteractionRouter at TOOL priority (above the priority-0
// pan/zoom defaults, so the chart stops panning while armed — T1's yield). Anchors are
// DOMAIN-space (HorzKey + price + paneId), resolved via the PUBLIC seams only:
// coordinateToLogical (float, T2) + logicalToKey(..,{extrapolate:true}) so a shape can
// sit OFF the data grid (T5); the inverse keyToLogical(..,{extrapolate:true}) +
// logicalToCoordinate + series.priceToCoordinate render it back. Drag-edit uses the
// ranked hit-test where Point handles beat the Line body (T3). One trivial tool — a
// trend line — ships here and exercises T1–T8 end to end. Built on api/gfx/core ONLY
// (arch §3.1); never model/views/host. ShapeHandle/ToolHostEvent/Anchor/ToolDefinition
// are owned HERE (design 05 §4 / design 02 §3.2 delegation).
import { DisplayListBuilder, HitPriority, LineStyle, ZBand } from '../../gfx';
import type { DisplayList, HitCandidate, SceneSource, ViewFrame } from '../../gfx';
import type { Coordinate, DeepPartial, Unsubscribe } from '../../core';
import type {
  AxisLabel,
  GestureEvent,
  GestureResponse,
  IChart,
  IPane,
  IPrimitive,
  ISeries,
  ITimeScale,
  PrimitiveContext,
  PrimitiveSource,
} from '../../api';

// --- owned public shapes (design 05 §4.1) ------------------------------------------

/** A domain-space anchor: survives scroll/zoom/data-reload/serialize (§4.1). `key` is
 *  the behavior ordering key (plain number — UTC ts for time charts); `paneId` is the
 *  never-reused IPane.id() (T8). */
export interface Anchor {
  key: number;
  price: number;
  paneId: string;
  priceScaleId?: string;
}

/** A serialized shape — plain JSON, no live coordinates (§4.1). Generic over its style
 *  (default `unknown` — the type-erased form `exportAll`/`importAll` round-trip). */
export interface SerializedShape<TStyle = unknown> {
  type: string;
  version: number;
  anchors: readonly Anchor[];
  style: TStyle;
}

/** The committed shape primitive: an IPrimitive that re-anchors, toggles handles, and
 *  serializes itself to its style-typed JSON (§4.1). */
export interface IShapePrimitive<TStyle> extends IPrimitive {
  setAnchors(anchors: readonly Anchor[]): void;
  setSelected(selected: boolean): void;
  serialize(): SerializedShape<TStyle>;
}

/** A tool: type tag, anchor arity, default style, shape factory + optional preview (§4.1). */
export interface ToolDefinition<TStyle> {
  readonly type: string;
  readonly anchors: { min: number; max: number };
  readonly defaultStyle: TStyle;
  createShape(anchors: readonly Anchor[], style: TStyle): IShapePrimitive<TStyle>;
  preview?(anchors: readonly Anchor[], cursor: Anchor): IShapePrimitive<TStyle>;
}

/** A live, host-minted, read-only view of one committed shape (§4.1). `id` is the
 *  opaque stable key `select`/`remove`/every event carries. */
export interface ShapeHandle<TStyle = unknown> {
  readonly id: string;
  readonly type: string;
  readonly anchors: readonly Anchor[];
  readonly style: TStyle;
  readonly selected: boolean;
  applyStyle(patch: DeepPartial<TStyle>): void;
  serialize(): SerializedShape;
}

/** The `changed` payload — a four-verb discriminated union (§4.1). */
export type ToolHostEvent =
  | { kind: 'added'; id: string; shape: ShapeHandle }
  | { kind: 'edited'; id: string; shape: ShapeHandle }
  | { kind: 'removed'; id: string }
  | { kind: 'selected'; id: string | null };

export interface IToolHost {
  registerTool(def: ToolDefinition<unknown>): void;
  arm(type: string, style?: unknown): void;
  disarm(): void;
  shapes(): readonly ShapeHandle[];
  select(id: string | null): void;
  remove(id: string): void;
  exportAll(): SerializedShape[];
  importAll(shapes: readonly SerializedShape[]): void;
  subscribe(h: (e: ToolHostEvent) => void): Unsubscribe;
}

// Tools register above the priority-0 defaults (design 05 §4 / behaviors.ts §13.5).
const TOOL_PRIORITY = 100;

// --- the host ----------------------------------------------------------------------

/**
 * Build the tool host for `chart` (design 05 §4 — value export createToolHost, A-6).
 * It claims the gesture stream while armed (the default pan/zoom yield, T1), maps
 * pointer→domain through the public time-scale + first-series-on-pane price seam, and
 * drives the create/edit FSM over pane-attached IShapePrimitives (T4/T6).
 */
export function createToolHost<H = unknown>(chart: IChart<H>): IToolHost {
  const ts = chart.timeScale() as unknown as ITimeScale;
  const router = chart.input();
  const tools = new Map<string, ToolDefinition<unknown>>();
  const listeners = new Set<(e: ToolHostEvent) => void>();
  const fire = (e: ToolHostEvent): void => {
    for (const h of [...listeners]) h(e);
  };

  // committed shapes, in z-order; each keyed by its minted id.
  interface Live {
    id: string;
    def: ToolDefinition<unknown>;
    style: unknown;
    anchors: Anchor[];
    shape: IShapePrimitive<unknown>;
    pane: IPane<H>;
  }
  const live: Live[] = [];
  let nextId = 0;
  let selectedId: string | null = null;

  // --- pane / series resolution + attach (public seams only; IPane.id() = T8) ------
  // chart.panes() returns the §11 IPane facade; cast to the full handle (its surface,
  // incl. id()/series()/attachPrimitive, is the same object). attachPrimitive takes the
  // model IPrimitive, so a shape goes in through `unknown` (the §12.4 plugin cast).
  const panes = (): readonly IPane<H>[] => chart.panes() as unknown as readonly IPane<H>[];
  const paneById = (id: string): IPane<H> | null => panes().find((p) => p.id() === id) ?? null;
  const paneByIndex = (i: number): IPane<H> | null => {
    const ps = panes();
    return i >= 0 && i < ps.length ? ps[i]! : null;
  };
  const firstSeries = (pane: IPane<H>): ISeries | null => {
    const list = pane.series();
    return list.length > 0 ? (list[0] as unknown as ISeries) : null;
  };
  const attach = (l: Live): void => l.pane.attachPrimitive(l.shape as never);
  const detach = (l: Live): void => l.pane.detachPrimitive(l.shape as never);

  // pointer (media px) → domain Anchor, OFF-GRID capable: x→FLOAT logical (T2) →key with
  // extrapolate (T5); y→price via the pane's first series (or 0 when series-less).
  const anchorAt = (x: number, y: number, pane: IPane<H>): Anchor | null => {
    const logical = ts.coordinateToLogical(x); // float (T2)
    if (logical === null) return null;
    const key = ts.logicalToKey(logical as number, { extrapolate: true }); // off-grid (T5)
    if (key === null) return null;
    const s = firstSeries(pane);
    const price = s !== null ? (s.coordinateToPrice(y) as number | null) : 0;
    return { key: key as number, price: price ?? 0, paneId: pane.id() };
  };

  const handleFor = (l: Live): ShapeHandle => ({
    id: l.id,
    type: l.def.type,
    get anchors(): readonly Anchor[] {
      return l.anchors;
    },
    get style(): unknown {
      return l.style;
    },
    get selected(): boolean {
      return selectedId === l.id;
    },
    applyStyle(patch): void {
      // re-run createShape semantics; swap the fresh primitive in place (§4.1).
      detach(l);
      l.style = mergeStyle(l.style, patch);
      l.shape = l.def.createShape(l.anchors, l.style);
      attach(l);
      l.shape.setSelected(selectedId === l.id);
      fire({ kind: 'edited', id: l.id, shape: handleFor(l) });
    },
    serialize: () => serializeLive(l),
  });

  const serializeLive = (l: Live): SerializedShape => ({
    type: l.def.type,
    version: 1,
    anchors: l.anchors.map((a) => ({ ...a })),
    style: l.style,
  });

  // --- the creation FSM: idle → armed → placing(k/n) → committed -------------------
  let armed: { def: ToolDefinition<unknown>; style: unknown } | null = null;
  let placing: { def: ToolDefinition<unknown>; style: unknown; pane: IPane<H>; anchors: Anchor[]; preview: IShapePrimitive<unknown> } | null = null;
  let editing: { l: Live; idx: number } | null = null; // an in-progress anchor drag-edit

  // drop any live placement preview (commit / disarm / re-arm) — idempotent.
  const clearPreview = (): void => {
    if (placing === null) return;
    placing.pane.detachPrimitive(placing.preview as never);
    placing = null;
  };

  const commit = (): void => {
    if (placing === null) return;
    const { def, style, pane, anchors } = placing;
    clearPreview();
    armed = null;
    const id = 'shape-' + nextId++;
    const l: Live = { id, def, style, anchors, shape: def.createShape(anchors, style), pane };
    live.push(l);
    attach(l);
    fire({ kind: 'added', id, shape: handleFor(l) });
  };

  // hit-test the committed shapes' handle/body sources, ranked (Point beats Line, T3).
  const hitShape = (x: number, y: number, frame: ViewFrame): { l: Live; idx: number } | null => {
    let best: { l: Live; idx: number; c: HitCandidate } | null = null;
    for (const l of live) {
      for (const src of sourcesOf(l.shape)) {
        const c = src.hitTest?.(x as Coordinate, y as Coordinate, frame);
        if (c === null || c === undefined) continue;
        // Point beats non-Point; then nearer distance (gfx §5.5 arbitration).
        if (best === null || c.priority > best.c.priority || (c.priority === best.c.priority && c.distance < best.c.distance)) {
          const idx = typeof c.data === 'number' ? (c.data as number) : -1;
          best = { l, idx, c };
        }
      }
    }
    return best === null ? null : { l: best.l, idx: best.idx };
  };

  // --- the router handler bundle (tap places, hover previews, drag edits) ----------
  const onGesture = (e: GestureEvent): GestureResponse => {
    const pane = paneByIndex(e.paneIndex);

    // armed/placing: TAP adds an anchor; the final one commits. Always claim so the
    // chart stops panning (T1). HOVER updates the preview via requestUpdate('overlay').
    if (armed !== null || placing !== null) {
      if (pane === null) return 'claim';
      if (e.kind === 'tap') {
        const a = anchorAt(e.x, e.y, pane);
        if (a === null) return 'claim';
        if (placing === null) {
          const def = armed!.def;
          const anchors = [a];
          const preview = (def.preview ?? def.createShape)(anchors, armed!.style) as IShapePrimitive<unknown>;
          pane.attachPrimitive(preview as never);
          placing = { def, style: armed!.style, pane, anchors, preview };
        } else {
          placing.anchors.push(a);
          placing.preview.setAnchors(placing.anchors);
        }
        // Commit when placement is COMPLETE. For a fixed-arity tool (min === max — e.g. the
        // trend line, 2/2) that is reaching `min`. For a multi-anchor tool (max > min) keep
        // collecting taps until `max`; committing at `min` here would make anchors past `min`
        // unreachable (the creation-FSM bug). (An explicit finish gesture for an
        // open-ended/optional-tail tool would commit between min and max; none ship yet.)
        const { min, max } = placing.def.anchors;
        if (placing.anchors.length >= max || (min === max && placing.anchors.length >= min)) commit();
        return 'claim';
      }
      if (e.kind === 'hover' && placing !== null) {
        const a = anchorAt(e.x, e.y, pane);
        if (a !== null) placing.preview.setAnchors([...placing.anchors, a]);
        return 'claim';
      }
      return 'claim';
    }

    // not armed: drive a drag-edit on the SELECTED shape's grabbed handle (T3). The
    // ranked hit-test (Point handle beats Line body) selects which anchor we drag.
    if (e.kind === 'drag' && pane !== null) {
      if (e.phase === 'start') {
        const hit = hitShape(e.x, e.y, FRAME0);
        if (hit === null || hit.idx < 0) return 'pass'; // let the default pan handle it
        select(hit.l.id);
        editing = { l: hit.l, idx: hit.idx };
        return 'claim';
      }
      if (editing === null) return 'pass';
      if (e.phase === 'move') {
        const a = anchorAt(e.x, e.y, editing.l.pane);
        if (a !== null) {
          editing.l.anchors[editing.idx] = a;
          editing.l.shape.setAnchors(editing.l.anchors);
          fire({ kind: 'edited', id: editing.l.id, shape: handleFor(editing.l) });
        }
        return 'claim';
      }
      if (e.phase === 'end' || e.phase === 'cancel') {
        editing = null;
        return 'claim';
      }
    }
    return 'pass';
  };

  // register the press/hover/drag bundle at TOOL priority — above the priority-0 pan/
  // zoom defaults, so the chart stops panning while a tool is armed (T1). chart.dispose
  // clears the router table, so no explicit teardown member is needed.
  router.register({ kinds: ['tap', 'hover', 'drag'], surfaces: ['pane'], priority: TOOL_PRIORITY, handler: onGesture });

  // --- selection ------------------------------------------------------------------
  const select = (id: string | null): void => {
    if (id === selectedId) return; // value no-op (no echo)
    selectedId = id;
    for (const l of live) l.shape.setSelected(l.id === id);
    fire({ kind: 'selected', id });
  };

  // --- the public host ------------------------------------------------------------
  return {
    registerTool(def): void {
      tools.set(def.type, def);
    },
    arm(type, style): void {
      const def = tools.get(type);
      if (def === undefined) throw new RangeError(`tool-host: unknown tool '${type}'`);
      clearPreview(); // abandon any in-progress placement
      armed = { def, style: style === undefined ? def.defaultStyle : mergeStyle(def.defaultStyle, style as DeepPartial<unknown>) };
    },
    disarm(): void {
      clearPreview();
      armed = null;
    },
    shapes(): readonly ShapeHandle[] {
      return live.map(handleFor);
    },
    select,
    remove(id): void {
      const i = live.findIndex((l) => l.id === id);
      if (i < 0) return;
      const l = live[i]!;
      detach(l);
      live.splice(i, 1);
      if (selectedId === id) selectedId = null;
      fire({ kind: 'removed', id });
    },
    exportAll(): SerializedShape[] {
      return live.map(serializeLive);
    },
    importAll(shapes): void {
      for (const s of shapes) {
        const def = tools.get(s.type);
        if (def === undefined) {
          // unknown type: skip with a warn, but the export array round-trips it (§4.1).
          console.warn(`tool-host: importAll skipped unknown tool '${s.type}'`);
          continue;
        }
        // unknown paneId resolves to pane 0 with a one-time warn (§4.1).
        let pane = paneById(s.anchors[0]?.paneId ?? '');
        if (pane === null) {
          console.warn('tool-host: importAll remapped unknown paneId to pane 0');
          pane = paneByIndex(0);
        }
        if (pane === null) continue;
        const anchors = s.anchors.map((a) => ({ ...a, paneId: pane!.id() }));
        const style = mergeStyle(def.defaultStyle, s.style as DeepPartial<unknown>);
        const id = 'shape-' + nextId++;
        const l: Live = { id, def, style, anchors, shape: def.createShape(anchors, style), pane };
        live.push(l);
        attach(l);
        fire({ kind: 'added', id, shape: handleFor(l) });
      }
    },
    subscribe(h): Unsubscribe {
      listeners.add(h);
      return () => void listeners.delete(h);
    },
  };
}

// a zero ViewFrame for headless hit-test driving (sources only read it opportunistically).
const FRAME0: ViewFrame = {
  frame: { mediaSize: { width: 0, height: 0 }, bitmapSize: { width: 0, height: 0 }, hr: 1, vr: 1 },
  now: 0,
} as unknown as ViewFrame;

// shallow style merge (styles are flat option objects, §4.1).
function mergeStyle<T>(base: T, patch: DeepPartial<T> | unknown): T {
  return { ...(base as object), ...(patch as object) } as T;
}

// the SceneSources a shape primitive exposes (its sources() narrowed to gfx sources).
function sourcesOf(shape: IPrimitive): readonly SceneSource[] {
  return (shape.sources?.() ?? []).map((s) => s.source as unknown as SceneSource);
}

// =====================================================================================
// THE TRIVIAL IN-TREE TOOL — a trend line (design 05 §4 T7). Two anchors; a line body
// (HitPriority.Line) plus two grab handles (HitPriority.Point) shown when selected;
// pane-attached IShapePrimitive over the public ctx (T4/T6). Renders OFF the data grid
// via keyToLogical({extrapolate:true}) (T5).
// =====================================================================================

export interface TrendLineStyle {
  color: string;
  width: number;
}
export const trendLineDefaults: TrendLineStyle = { color: '#2962FF', width: 2 };

/** The trend-line ToolDefinition (the in-tree consumer proving T1–T8). */
export const TrendLineTool: ToolDefinition<TrendLineStyle> = {
  type: 'trend-line',
  anchors: { min: 2, max: 2 },
  defaultStyle: trendLineDefaults,
  createShape: (anchors, style) => createTrendLine(anchors, style),
  preview: (anchors, _cursor) => createTrendLine(anchors as readonly Anchor[], trendLineDefaults),
};

function createTrendLine(initial: readonly Anchor[], style: TrendLineStyle): IShapePrimitive<TrendLineStyle> {
  let anchors: Anchor[] = initial.map((a) => ({ ...a }));
  let selected = false;
  const curStyle = { ...style };
  let ctx: PrimitiveContext | null = null;

  const builder = new DisplayListBuilder();
  const HANDLE_R = 5;

  // resolve an anchor to media-px (x,y) through the PUBLIC seams; null off-screen.
  const project = (a: Anchor): { x: number; y: number } | null => {
    if (ctx === null) return null;
    const ts = ctx.chart.timeScale() as unknown as ITimeScale;
    const logical = ts.keyToLogical(a.key, { extrapolate: true }); // off-grid (T5)
    if (logical === null) return null;
    const x = ts.logicalToCoordinate(logical as number);
    if (x === null) return null;
    const s = (ctx.series ?? firstOnPane(ctx)) as ISeries | null;
    const y = s !== null ? s.priceToCoordinate(a.price) : null;
    if (y === null) return null;
    return { x: x as number, y: y as number };
  };

  const source: SceneSource = {
    zBand: ZBand.AboveSeries,
    update(): void {}, // lists are projected lazily in displayLists() from the live anchors
    displayLists(): readonly DisplayList[] {
      if (anchors.length < 2) return [];
      const p0 = project(anchors[0]!);
      const p1 = project(anchors[1]!);
      if (p0 === null || p1 === null) return [];
      builder.reset();
      builder.beginList('media');
      const line = builder.polyline(curStyle.width, LineStyle.Solid, 'round');
      line.vertex(p0.x, p0.y, curStyle.color);
      line.vertex(p1.x, p1.y, curStyle.color);
      if (selected) {
        const dots = builder.circles();
        dots.circle(p0.x, p0.y, HANDLE_R, curStyle.color);
        dots.circle(p1.x, p1.y, HANDLE_R, curStyle.color);
      }
      return builder.finish();
    },
    hitTest(x, y): HitCandidate | null {
      const p0 = project(anchors[0]!);
      const p1 = project(anchors[1]!);
      if (p0 === null || p1 === null) return null;
      // grab handles first (Point) when selected — ranked above the body so a handle
      // wins the arbitration for free (T3). data carries the anchor index for drag-edit.
      if (selected) {
        const d0 = Math.hypot((x as number) - p0.x, (y as number) - p0.y);
        const d1 = Math.hypot((x as number) - p1.x, (y as number) - p1.y);
        if (d0 <= HANDLE_R + 3 || d1 <= HANDLE_R + 3) {
          const idx = d0 <= d1 ? 0 : 1;
          return { distance: idx === 0 ? d0 : d1, priority: HitPriority.Point, data: idx };
        }
      }
      const d = segDistance(x as number, y as number, p0, p1);
      return d <= 4 ? { distance: d, priority: HitPriority.Line, data: -1 } : null;
    },
  };

  return {
    attached: (c: PrimitiveContext): void => void (ctx = c),
    detached: (): void => void (ctx = null),
    sources: (): readonly PrimitiveSource[] => [{ target: 'pane', source } as unknown as PrimitiveSource],
    // a price label per anchor (T6 — pane-attached primitive axis labels render).
    priceAxisLabels: (): readonly AxisLabel[] => anchors.map((a) => labelAt(a.price, curStyle.color)),
    autoscale: (): null => null,
    setAnchors: (next): void => {
      anchors = next.map((a) => ({ ...a }));
      ctx?.requestUpdate('render');
    },
    setSelected: (s): void => {
      selected = s;
      ctx?.requestUpdate('overlay');
    },
    serialize: (): SerializedShape<TrendLineStyle> => ({ type: 'trend-line', version: 1, anchors: anchors.map((a) => ({ ...a })), style: curStyle }),
  };
}

function firstOnPane(ctx: PrimitiveContext): ISeries | null {
  // ctx.pane is the §11 IPane facade (PrimitiveContext types it as the chart placeholder
  // that carries only index()); narrow to the full handle for series() (same object).
  const list = (ctx.pane as unknown as IPane).series();
  return list.length > 0 ? (list[0] as unknown as ISeries) : null;
}

function labelAt(price: number, color: string): AxisLabel {
  return { coordinate: () => price, text: () => price.toFixed(2), textColor: () => '#FFFFFF', backColor: () => color, visible: () => true };
}

// point→segment distance in media px (study 08 §3.9 line-body hit geometry).
function segDistance(px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - a.x, py - a.y);
  let t = ((px - a.x) * dx + (py - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}
