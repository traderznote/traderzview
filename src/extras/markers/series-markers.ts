// traderzview · extras/markers — series markers plugin (design 05 §2.7 item 1;
// study 08 §4.4 is the algorithm spec of record). createSeriesMarkers attaches an
// IPrimitive to a series; it registers ONE AboveSeries-band SceneSource that emits
// each marker as a circle / square / arrowUp|arrowDown path plus its text, and
// hit-tests with real shape-edge distances (HoverInfo.kind:"primitive" + the marker
// id as externalId), and contributes MAX-merged autoscale margins. Marker STATE
// lives here on the plugin (NO Series field, arch §4.6). Built ONLY on the public
// api seams (ISeries/IChart/ITimeScale) + gfx + the extras/shared adapter — never
// model/views (arch §3.1). The data-changed subscription is torn down in detached().
import { ceiledEven, ceiledOdd, crispRound, DisplayListBuilder, HitPriority, ZBand } from '../../gfx';
import type { DisplayList, HitCandidate, SceneSource, ViewFrame } from '../../gfx';
import { mergeOptions } from '../../core';
import type { Coordinate, DeepPartial } from '../../core';
import type { AutoscaleInfo, IChart, IPrimitive, ISeries, ITimeScale, PrimitiveSource, SeriesType } from '../../api';
import { createPrimitiveAdapter, type PrimitiveAdapter } from '../shared';

// --- public marker + option shapes (study 08 §4.16 defaults; kept) -----------------

/** Where a marker sits relative to its bar (study 08 §4.4). String union, no enum. */
export type SeriesMarkerPosition =
  | 'aboveBar'
  | 'belowBar'
  | 'inBar'
  | 'atPriceTop'
  | 'atPriceBottom'
  | 'atPriceMiddle';

/** The drawn glyph. `arrowUp`/`arrowDown` are path arrows; chevron is via polyline. */
export type SeriesMarkerShape = 'circle' | 'square' | 'arrowUp' | 'arrowDown';

/** One marker. `time` is the chart's H item; `price` is REQUIRED for the atPrice*
 *  positions (validation throws otherwise, §4.4) and IGNORED for the bar-relative
 *  positions (aboveBar/belowBar/inBar). `size` scales the glyph (≥0). */
export interface SeriesMarker<H = unknown> {
  time: H;
  position: SeriesMarkerPosition;
  shape: SeriesMarkerShape;
  color: string;
  id?: string;
  text?: string;
  size?: number;
  /** REQUIRED for atPriceTop / atPriceBottom / atPriceMiddle (the marker's y anchor);
   *  ignored for the bar-relative positions. Validation throws when missing (§4.4). */
  price?: number;
}

/** Plugin options (standard §5.1 merge via the adapter). `validation` mirrors the
 *  series-data ascending check: 'throw' (default) rejects unsorted input. */
export interface SeriesMarkersOptions {
  visible: boolean;
  textColor: string;
  fontSize: number;
  fontFamily: string;
  autoScale: boolean;
  validation: 'throw' | 'skip' | 'none';
}

export const defaultSeriesMarkersOptions: SeriesMarkersOptions = {
  visible: true,
  textColor: '#191919',
  fontSize: 12,
  fontFamily: "-apple-system, system-ui, 'Helvetica Neue', Helvetica, Arial, sans-serif",
  autoScale: true,
  validation: 'throw',
};

/** The §12.4 adapter handle: { detach, applyOptions } + the marker methods. */
export type SeriesMarkersHandle<H = unknown> = PrimitiveAdapter<
  SeriesMarkersOptions,
  {
    setMarkers(markers: readonly SeriesMarker<H>[]): void;
    markers(): readonly SeriesMarker<H>[];
  }
>;

// --- sizing (study 08 §4.4 — verbatim) ---------------------------------------------

const MIN_SHAPE = 12;
const MAX_SHAPE = 30;
const MIN_MARGIN = 3;
const TEXT_MARGIN = 0.1;

function base(bs: number, coeff: number): number {
  return ceiledOdd(Math.min(Math.max(bs, MIN_SHAPE), MAX_SHAPE) * coeff);
}
function shapeSize(shape: SeriesMarkerShape, bs: number): number {
  if (shape === 'arrowUp' || shape === 'arrowDown') return base(bs, 1);
  if (shape === 'circle') return base(bs, 0.8);
  return base(bs, 0.7); // square
}
function shapeHeight(bs: number): number {
  return ceiledEven(base(bs, 1));
}
function shapeMargin(bs: number): number {
  return Math.max(base(bs, 0.1), MIN_MARGIN);
}

// --- the resolved (laid-out) marker, ready to draw + hit-test ----------------------

/** A public data item as `dataByIndex` returns it — single-value or OHLC. */
interface BarItem {
  readonly value?: number; // single-value series (close/value role)
  readonly open?: number;
  readonly high?: number;
  readonly low?: number;
  readonly close?: number;
}

interface Resolved {
  readonly logical: number; // final on-grid logical index of the snapped bar (→ x)
  readonly bar: BarItem; // the snapped bar's prices (read from dataByIndex, not the store)
  readonly marker: SeriesMarker;
}

interface Placed {
  readonly x: number; // media-px center
  readonly y: number; // media-px center (shape center)
  readonly size: number; // glyph extent (shapeHeight·sizeMul)
  readonly half: number;
  readonly shape: SeriesMarkerShape;
  readonly color: string;
  readonly id: string;
  readonly text?: string;
  readonly textY?: number; // media-px text baseline-middle, when text present
}

const EMPTY: readonly DisplayList[] = [];

// --- the SceneSource: layout + emit + hit, all over the captured public seams ------

interface Geom {
  readonly series: ISeries;
  readonly timeScale: ITimeScale;
}

interface SourceState {
  readonly markers: readonly SeriesMarker[];
  readonly options: SeriesMarkersOptions;
  /** Monotonic; bumps on setMarkers / option change / data-changed so a same-length
   *  marker swap still forces a layout rebuild (the signature includes it). */
  readonly rev: number;
  resolve(): readonly Resolved[];
}

function createMarkersSource(geom: Geom, state: SourceState): SceneSource {
  const builder = new DisplayListBuilder();
  let cached: readonly DisplayList[] = EMPTY;
  let placed: readonly Placed[] = [];
  let sig: string | null = null;

  // Inversion is read behaviourally from the public ISeries.priceToCoordinate seam
  // (the series handle exposes no invertScale): in a normal scale a higher price maps
  // to a SMALLER y. We probe two prices and compare. (study 08 §4.4: aboveBar→high,
  // low if inverted.)
  function inverted(): boolean {
    const a = geom.series.priceToCoordinate(0);
    const b = geom.series.priceToCoordinate(1);
    return a !== null && b !== null && (b as number) > (a as number);
  }

  function signature(frame: ViewFrame): string {
    const f = frame.frame;
    return `${state.rev}|${geom.timeScale.barSpacing()}|${geom.timeScale.rightOffset()}|${state.options.visible}|${state.options.fontSize}|${f.hr}|${f.vr}|${f.bitmapSize.height}`;
  }

  function layout(): readonly Placed[] {
    if (!state.options.visible) return [];
    const bs = geom.timeScale.barSpacing();
    const margin = shapeMargin(bs);
    const fontSize = state.options.fontSize;
    const inv = inverted();
    const out: Placed[] = [];
    // Per-side stacking offsets, RESET whenever the bar (logical) changes (§4.4).
    let lastLogical = Number.NaN;
    let above = margin;
    let below = margin;

    for (const r of state.resolve()) {
      const m = r.marker;
      if (r.logical !== lastLogical) {
        lastLogical = r.logical;
        above = margin;
        below = margin;
      }
      const size = shapeHeight(bs) * Math.max(m.size ?? 1, 0);
      const half = size / 2;

      const price = priceFor(r.bar, m, inv);
      if (price === null) continue; // whitespace bar / undefined price → skip (y unset)
      const x = geom.timeScale.logicalToCoordinate(r.logical);
      const yc = geom.series.priceToCoordinate(price);
      if (x === null || yc === null) continue;
      const isAtPrice = m.position === 'atPriceTop' || m.position === 'atPriceBottom' || m.position === 'atPriceMiddle';
      const hasText = m.text !== undefined && m.text.length > 0;

      let y: number;
      let textY: number | undefined;
      if (m.position === 'inBar' || m.position === 'atPriceMiddle') {
        y = yc as number;
        if (hasText) textY = y + half + margin + fontSize * (0.5 + TEXT_MARGIN);
      } else if (m.position === 'aboveBar' || m.position === 'atPriceTop') {
        const off = isAtPrice ? 0 : above;
        y = (yc as number) - half - off;
        if (hasText) textY = y - half - fontSize * (0.5 + TEXT_MARGIN);
        if (hasText) above += fontSize * (1 + 2 * TEXT_MARGIN);
        if (!isAtPrice) above += size + margin;
      } else {
        // belowBar | atPriceBottom — mirror image
        const off = isAtPrice ? 0 : below;
        y = (yc as number) + half + off;
        if (hasText) textY = y + half + fontSize * (0.5 + TEXT_MARGIN);
        if (hasText) below += fontSize * (1 + 2 * TEXT_MARGIN);
        if (!isAtPrice) below += size + margin;
      }

      out.push({
        x: x as number,
        y,
        size,
        half,
        shape: m.shape,
        color: m.color,
        id: m.id ?? '',
        text: hasText ? m.text : undefined,
        textY,
      });
    }
    return out;
  }

  function build(frame: ViewFrame): readonly DisplayList[] {
    if (placed.length === 0) return EMPTY;
    const f = frame.frame;
    const hr = f.hr;
    const vr = f.vr;
    const tickWidth = Math.max(1, Math.floor(hr));
    const correction = (tickWidth % 2) / 2;

    builder.reset();
    builder.beginList('bitmap');
    // glyph fills, grouped per primitive command kind
    const circ = builder.circles();
    for (const p of placed) {
      if (p.shape !== 'circle') continue;
      const xb = crispRound(p.x, hr) + correction;
      const yb = p.y * vr;
      const r = ((p.size - 1) / 2) * vr;
      circ.circle(xb, yb, Math.max(0, r), p.color);
    }
    const sq = builder.rects({});
    for (const p of placed) {
      if (p.shape !== 'square') continue;
      const side = p.size * vr;
      const left = (crispRound(p.x, hr) + correction) - ((p.size - 1) / 2) * hr;
      const top = p.y * vr - ((p.size - 1) / 2) * vr;
      sq.quad(left, top, Math.max(0, side), Math.max(0, side), p.color);
    }
    for (const p of placed) {
      if (p.shape !== 'arrowUp' && p.shape !== 'arrowDown') continue;
      emitArrow(builder, p, hr, vr, correction);
    }
    // text in a media-space list (resolution-independent, §4.4)
    const labels = placed.filter((p) => p.text !== undefined && p.textY !== undefined);
    if (labels.length > 0) {
      builder.beginList('media');
      builder.text(
        labels.map((p) => ({
          x: p.x - measureText(p.text!, state.options.fontSize) / 2,
          y: p.textY!,
          text: p.text!,
          font: { family: state.options.fontFamily, size: state.options.fontSize },
          color: state.options.textColor,
        })),
      );
    }
    return builder.finish();
  }

  return {
    zBand: ZBand.AboveSeries,
    update(frame: ViewFrame): void {
      const next = signature(frame);
      if (next === sig) return;
      sig = next;
      placed = layout();
      cached = build(frame);
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
    hitTest(x: Coordinate, y: Coordinate): HitCandidate | null {
      // First-in-array hit wins (no distance ranking among markers); real shape-edge
      // distance (0 inside) so cross-source arbitration ranks markers fairly (§2.4).
      for (const p of placed) {
        const d = hitDistance(p, x as number, y as number, state.options.fontSize);
        if (d !== null) {
          return { distance: d, priority: HitPriority.Point, externalId: p.id, data: p.id };
        }
      }
      return null;
    },
  };
}

// --- shape geometry helpers (study 08 §4.4) ----------------------------------------

function emitArrow(builder: DisplayListBuilder, p: Placed, hr: number, vr: number, correction: number): void {
  const up = p.shape === 'arrowUp';
  const sign = up ? -1 : 1; // up-arrow head ABOVE center (smaller y)
  const arrowSize = shapeSize('arrowUp', p.size); // head uses the arrow base
  const headHalf = (arrowSize - 1) / 2;
  const stemHalf = (ceiledOdd(p.size / 2) - 1) / 2;
  const xb = crispRound(p.x, hr) + correction;
  const yb = p.y * vr;
  const half = p.half;
  const path = builder.path(p.color);
  // head triangle (apex at the far end, base at center line)
  path.move(xb, yb + sign * half * vr);
  path.line(xb - headHalf * hr, yb);
  path.line(xb + headHalf * hr, yb);
  path.close();
  // stem rectangle (from center line to the near end), as a closed quad
  const sx = stemHalf * hr;
  const ey = yb - sign * half * vr;
  path.move(xb - sx, yb);
  path.line(xb + sx, yb);
  path.line(xb + sx, ey);
  path.line(xb - sx, ey);
  path.close();
}

/** Distance from (x,y) to the marker shape edge in media px, or null when outside the
 *  shape's hit region. 0 inside. Geometry per study 08 §4.4. */
function hitDistance(p: Placed, x: number, y: number, fontSize: number): number | null {
  const dx = x - p.x;
  const dy = y - p.y;
  if (p.shape === 'circle') {
    const r = (p.size - 1) / 2;
    const dist = Math.hypot(dx, dy);
    const tol = 2 + p.size / 2;
    return dist <= tol ? Math.max(0, dist - r) : textHit(p, x, y, fontSize);
  }
  if (p.shape === 'square') {
    const h = (p.size - 1) / 2;
    if (Math.abs(dx) <= h && Math.abs(dy) <= h) return 0;
    return textHit(p, x, y, fontSize);
  }
  // arrow: stem rect (expanded 2px) OR head triangle (3px-expanded box; dy+3 ≥ dx/2)
  const up = p.shape === 'arrowUp';
  const sign = up ? -1 : 1;
  const stemHalf = (ceiledOdd(p.size / 2) - 1) / 2;
  const inStem = Math.abs(dx) <= stemHalf + 2 && (up ? dy >= -p.half - 2 && dy <= 2 : dy <= p.half + 2 && dy >= -2);
  if (inStem) return 0;
  // head: bounding box around the apex side, 3px-expanded
  const headHalf = (shapeSize('arrowUp', p.size) - 1) / 2;
  const ady = sign * dy; // distance toward the apex (positive = toward head)
  if (Math.abs(dx) <= headHalf + 3 && ady >= -3 && ady <= p.half + 3 && ady + 3 >= Math.abs(dx) / 2) return 0;
  return textHit(p, x, y, fontSize);
}

function textHit(p: Placed, x: number, y: number, fontSize: number): number | null {
  if (p.text === undefined || p.textY === undefined) return null;
  const w = measureText(p.text, fontSize);
  const h = fontSize;
  if (x >= p.x - w / 2 && x <= p.x + w / 2 && Math.abs(y - p.textY) <= h / 2) return 0;
  return null;
}

// A standalone measure (no backend in this layer): a stable per-char estimate. Real
// drawing measures via the backend; hit geometry only needs a deterministic box.
function measureText(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6;
}

// --- price selection (single-value `current` / OHLC high|low|close, study 08 §4.4) -

function priceFor(bar: BarItem, m: SeriesMarker, inv: boolean): number | null {
  if (m.position === 'atPriceTop' || m.position === 'atPriceBottom' || m.position === 'atPriceMiddle') {
    // validation already guaranteed price !== undefined for atPrice* markers
    return m.price ?? null;
  }
  // single-value series: value (== close/high/low role); OHLC: close/high/low.
  const close = bar.close ?? bar.value;
  const high = bar.high ?? bar.value;
  const low = bar.low ?? bar.value;
  if (close === undefined || !Number.isFinite(close)) return null;
  if (m.position === 'inBar') return close;
  if (m.position === 'aboveBar') return (inv ? low : high) ?? null;
  return (inv ? high : low) ?? null; // belowBar
}

// --- autoscale margins (study 08 §4.4 — cached on barSpacing) -----------------------

function autoscaleMargins(markers: readonly SeriesMarker[], bs: number): { above: number; below: number } {
  let hasAbove = false;
  let hasBelow = false;
  let hasIn = false;
  for (const m of markers) {
    if (m.position === 'aboveBar' || m.position === 'atPriceTop') hasAbove = true;
    else if (m.position === 'belowBar' || m.position === 'atPriceBottom') hasBelow = true;
    else hasIn = true;
  }
  const ml = shapeHeight(bs) * 1.5 + shapeMargin(bs) * 2;
  const above = hasAbove ? ml : hasIn ? Math.ceil(ml / 2) : 0;
  const below = hasBelow ? ml : hasIn ? Math.ceil(ml / 2) : 0;
  return { above, below };
}

// --- index resolution (study 08 §4.4 + the §13.14 nearest-search FIX) ---------------

/** Resolve each marker's `time` to the on-grid logical index of the nearest EXISTING
 *  bar, snapping into the data range (times below the first bar snap right, all others
 *  snap nearest-left; past the last bar attaches to the last bar — §13.14 clamps to
 *  the END bar). Uses ONLY the public timeScale.timeToLogical + series.dataByIndex,
 *  both backed by the fixed total nearest-search. */
function resolveMarkers(geom: Geom, markers: readonly SeriesMarker[]): readonly Resolved[] {
  const data = geom.series.data();
  if (data.length === 0) return [];
  const firstLogical = geom.timeScale.timeToLogical((data[0] as { time: unknown }).time, 'nearest-right');
  const out: Resolved[] = [];
  for (const m of markers) {
    const guess = geom.timeScale.timeToLogical(m.time, 'nearest-right');
    if (guess === null) continue;
    const mode = firstLogical !== null && (guess as number) < (firstLogical as number) ? 'nearest-right' : 'nearest-left';
    const bar = geom.series.dataByIndex(guess as number, mode) as ({ time: unknown } & BarItem) | null;
    if (bar === null) continue; // whitespace bar (dataByIndex returns null, §4.4)
    const finalLogical = geom.timeScale.timeToLogical(bar.time, 'none');
    if (finalLogical === null) continue;
    out.push({ logical: finalLogical as number, bar, marker: m });
  }
  return out;
}

// --- ascending-by-time validation (mirrors series-data validation, §2.7 item 1) ----

function validate(markers: readonly SeriesMarker<unknown>[], geom: Geom, mode: SeriesMarkersOptions['validation']): readonly SeriesMarker<unknown>[] {
  // atPrice* markers MUST carry a price (study 08 §4.4 throws). Always enforced (it is
  // a structural error, not an ordering policy) — except under 'none'.
  if (mode !== 'none') {
    for (const m of markers) {
      const isAtPrice = m.position === 'atPriceTop' || m.position === 'atPriceBottom' || m.position === 'atPriceMiddle';
      if (isAtPrice && m.price === undefined) {
        throw new RangeError(`series-markers: a ${m.position} marker requires a 'price'`);
      }
    }
  }
  if (mode === 'none') return markers;
  // ascending-by-time via the behaviour key the timeScale exposes (logicalToKey path
  // is overkill; the timeScale orders H by its behaviour key — we compare resolved
  // keys through timeToLogical, which is monotonic in the ordering key).
  let prev = Number.NEGATIVE_INFINITY;
  const ok: SeriesMarker<unknown>[] = [];
  for (const m of markers) {
    const l = geom.timeScale.timeToLogical(m.time, 'nearest-left');
    const key = l === null ? prev : (l as number);
    if (key < prev) {
      if (mode === 'throw') {
        throw new RangeError('series-markers: markers must be in ascending time order');
      }
      continue; // 'skip'
    }
    prev = key;
    ok.push(m);
  }
  return ok;
}

// --- the factory (design 02 §12.4: createSeriesMarkers(chart, series, markers?, opts?))

/**
 * Attach a series-markers primitive to `series`. The `chart` is needed for the time
 * scale (marker time→logical resolution + logical→x); `ISeries` alone exposes no
 * time scale. Returns the §12.4 adapter handle. Auto-detach (series removal / pane
 * removal / chart.dispose) funnels through the same idempotent teardown; the data-
 * changed subscription is torn down in BOTH primitive.detached() (the auto-detach path)
 * AND the adapter's onDetach (the explicit handle.detach() path), guarded exactly-once.
 */
export function createSeriesMarkers<H = unknown>(
  chart: IChart<H>,
  series: ISeries<SeriesType, H>,
  markers?: readonly SeriesMarker<H>[],
  options?: DeepPartial<SeriesMarkersOptions>,
): SeriesMarkersHandle<H> {
  const geom: Geom = { series: series as unknown as ISeries, timeScale: chart.timeScale() as unknown as ITimeScale };

  // resolve the initial options patch over the kept defaults (standard §5.1 merge).
  let opts: SeriesMarkersOptions =
    options === undefined
      ? { ...defaultSeriesMarkersOptions }
      : mergeOptions(defaultSeriesMarkersOptions, options, defaultSeriesMarkersOptions);
  // resolved-marker memo, invalidated on setMarkers / data-changed.
  let raw: readonly SeriesMarker[] = [];
  let resolved: readonly Resolved[] | null = null;
  let rev = 0; // bumps on every state change so the source re-layouts
  // autoscale margin memo keyed on barSpacing (the hot path, §2.5).
  let marginBs = Number.NaN;
  let marginCache: { above: number; below: number } = { above: 0, below: 0 };

  const state: SourceState = {
    get markers(): readonly SeriesMarker[] {
      return raw;
    },
    get options(): SeriesMarkersOptions {
      return opts;
    },
    get rev(): number {
      return rev;
    },
    resolve(): readonly Resolved[] {
      if (resolved === null) resolved = resolveMarkers(geom, raw);
      return resolved;
    },
  };

  const source = createMarkersSource(geom, state);

  // data-changed invalidates the resolved-index memo (marker bars may have moved).
  // The teardown is IDEMPOTENT and runs on BOTH the auto-detach path (the host calls
  // primitive.detached() on series/pane removal + chart.dispose, design 05 §2.2) AND
  // the explicit handle.detach() path (the adapter's onDetach) — mirroring the other
  // three plugins, so the subscription never leaks when auto-detach fires (FIX 1).
  let teardownDone = false;
  const off = series.subscribeDataChanged(() => {
    resolved = null;
    rev++;
  });
  const teardown = (): void => {
    if (teardownDone) return; // exactly-once: a later detached()/onDetach is a no-op
    teardownDone = true;
    off();
  };

  const primitive: IPrimitive = {
    sources(): readonly PrimitiveSource[] {
      return [{ target: 'pane', source } as unknown as PrimitiveSource];
    },
    detached(): void {
      teardown(); // AUTO-detach (series/pane removal, chart.dispose) — the §2.2 leak fix
    },
    autoscale(): AutoscaleInfo | null {
      if (!opts.autoScale || raw.length === 0) return null;
      const bs = geom.timeScale.barSpacing();
      if (bs !== marginBs) {
        marginBs = bs;
        marginCache = autoscaleMargins(raw, bs);
      }
      // No extra price range — markers only widen the pixel margins (§2.5 max-merge).
      return { priceRange: null, margins: marginCache };
    },
  };

  const setMarkers = (next: readonly SeriesMarker<H>[]): void => {
    raw = validate(next as readonly SeriesMarker<unknown>[], geom, opts.validation) as readonly SeriesMarker[];
    resolved = null;
    rev++;
    marginBs = Number.NaN; // force margin recompute
  };
  if (markers !== undefined) setMarkers(markers);

  return createPrimitiveAdapter<SeriesMarkersOptions, {
    setMarkers(markers: readonly SeriesMarker<H>[]): void;
    markers(): readonly SeriesMarker<H>[];
  }>({
    target: series as unknown as { attachPrimitive(p: IPrimitive): void; detachPrimitive(p: IPrimitive): void },
    primitive,
    options: opts,
    defaults: defaultSeriesMarkersOptions,
    onChange(nextOpts): void {
      opts = nextOpts;
      resolved = null; // visible/fontSize affect layout
      rev++;
      marginBs = Number.NaN;
    },
    methods: {
      setMarkers,
      markers(): readonly SeriesMarker<H>[] {
        return raw as readonly SeriesMarker<H>[];
      },
    },
    onDetach: teardown, // explicit handle.detach() path — same idempotent teardown (FIX 1)
  }) as SeriesMarkersHandle<H>;
}
