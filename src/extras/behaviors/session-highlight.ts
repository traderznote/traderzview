// traderzview · extras/behaviors — the SESSION-HIGHLIGHTING primitive (design 05 §7.1;
// the S4/S5 in-tree proof). A PANE-attached IPrimitive that paints one BelowSeries-band
// rect per session span (the reference's own `session-highlighting` plugin pattern, study
// 08 §3.9) and, optionally, time-axis break ticks. Span computation walks the timeline's
// REAL slot keys via the PUBLIC `timeScale().keysInRange(range)` (S4 — whitespace-inclusive
// logical-range→real-slot-keys), classifies each key in/out of session through a
// `SessionSpec` ({ days, openMinutes, closeMinutes, tz }) using the SAME IANA offset
// function as the timezone behavior, and emits a media-space rect spanning each contiguous
// open run. Proves a pane primitive can emit BOTH a BelowSeries pane source AND a time-axis
// source (S5).
//
// Built ONLY on the PUBLIC api seams (IPrimitive / PrimitiveContext + the ITimeScale
// keysInRange / keyToLogical / logicalToCoordinate / getVisibleLogicalRange surface +
// IPane.size, design 02 §9/§11/§12) + gfx (ZBand / DisplayListBuilder) + the extras/shared
// adapter + the sibling offsetFor — never model/views (arch §3.1; dep-cruiser E1).
import { DisplayListBuilder, ZBand } from '../../gfx';
import type { DeepPartial } from '../../core';
import type { DisplayList, SceneSource, ViewFrame } from '../../gfx';
import type { IPrimitive, ITimeScale, PrimitiveContext, PrimitiveSource } from '../../api';
import { createPrimitiveAdapter } from '../shared';
import type { PrimitiveAdapter, PrimitiveTarget } from '../shared';
import { offsetFor } from './timezone-time-behavior';

// --- public session spec + options (design 05 §7.1) ---------------------------------

/** One trading session, in the venue's local wall clock (design 05 §7.1). `days` are the
 *  local weekdays the session is open (0=Sun … 6=Sat); `openMinutes`/`closeMinutes` are
 *  minutes-since-local-midnight; `tz` is the IANA zone the local clock is read in. A key
 *  (a UTC instant) is "in session" iff its LOCAL weekday is in `days` and its local
 *  minute-of-day is in `[openMinutes, closeMinutes)`. */
export interface SessionSpec {
  days: readonly number[];
  openMinutes: number;
  closeMinutes: number;
  tz: string;
}

/** Session-highlight options (standard §5.1 merge via the adapter). */
export interface SessionHighlightOptions {
  visible: boolean;
  /** The fill for an in-session band (any gfx FillStyle string). */
  color: string;
  /** Emit one time-axis tick at each session OPEN boundary (S5). */
  showBreaks: boolean;
  /** The break-tick color (time-axis source). */
  breakColor: string;
}

export const sessionHighlightDefaults: SessionHighlightOptions = {
  visible: true,
  color: 'rgba(40,98,255,0.08)',
  showBreaks: true,
  breakColor: 'rgba(40,98,255,0.5)',
};

/** The §12.4 adapter handle: { detach, applyOptions } + setSession. */
export type SessionHighlightHandle = PrimitiveAdapter<
  SessionHighlightOptions,
  { setSession(spec: SessionSpec): void }
>;

const EMPTY: readonly DisplayList[] = [];
const MIN_PER_DAY = 1440;
const SEC_PER_DAY = 86400;

/** Is `utcSeconds` in the session, in the spec's local zone? Pure key classification (S4
 *  feeds these keys straight from keysInRange — whitespace slots included). */
function inSession(utcSeconds: number, spec: SessionSpec, offset: (utc: number) => number): boolean {
  const localSec = utcSeconds + offset(utcSeconds);
  const dayOfWeek = (((Math.floor(localSec / SEC_PER_DAY) + 4) % 7) + 7) % 7; // 1970-01-01 = Thu(4)
  if (!spec.days.includes(dayOfWeek)) return false;
  const minuteOfDay = (((Math.floor(localSec / 60) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY);
  return minuteOfDay >= spec.openMinutes && minuteOfDay < spec.closeMinutes;
}

/** The geometry the source reads through the public ITimeScale + IPane seams. */
interface Geom {
  timeScale(): ITimeScale;
  paneHeight(): number;
}

/** A contiguous in-session run of slots: [startKey, endKey] (real timeline keys). */
interface Span {
  readonly startKey: number;
  readonly endKey: number;
}

function createSessionSource(
  geom: Geom,
  getOptions: () => SessionHighlightOptions,
  getSpec: () => SessionSpec | null,
  getRev: () => number,
): { pane: SceneSource; axis: SceneSource } {
  const builder = new DisplayListBuilder();
  const axisBuilder = new DisplayListBuilder();
  let spans: readonly Span[] = [];
  let cachedPane: readonly DisplayList[] = EMPTY;
  let cachedAxis: readonly DisplayList[] = EMPTY;
  let sig: string | null = null;

  // Walk keysInRange over the VISIBLE logical range (S4), grouping contiguous in-session
  // keys into spans. Whitespace slots are real keys keysInRange returns, so a closed-period
  // whitespace gap correctly ends an open run (the session-highlight use case, S4).
  function computeSpans(): readonly Span[] {
    const spec = getSpec();
    if (spec === null || !getOptions().visible) return [];
    const ts = geom.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (range === null) return [];
    const keys = ts.keysInRange({ from: range.from as unknown as number, to: range.to as unknown as number });
    if (keys.length === 0) return [];
    const offset = offsetFor(spec.tz);
    const out: Span[] = [];
    let runStart: number | null = null;
    let prev = 0;
    for (const k of keys) {
      const key = k as unknown as number;
      const open = inSession(key, spec, offset);
      if (open && runStart === null) runStart = key;
      else if (!open && runStart !== null) {
        out.push({ startKey: runStart, endKey: prev });
        runStart = null;
      }
      prev = key;
    }
    if (runStart !== null) out.push({ startKey: runStart, endKey: prev });
    return out;
  }

  // x (media-px) of a real timeline key, via keyToLogical → logicalToCoordinate (the
  // public off-grid pair). null when the scale cannot place it.
  function xOf(key: number): number | null {
    const ts = geom.timeScale();
    const logical = ts.keyToLogical(key, { extrapolate: true });
    if (logical === null) return null;
    const x = ts.logicalToCoordinate(logical as unknown as number);
    return x === null ? null : (x as unknown as number);
  }

  // Half a bar-spacing in media-px (a slot CENTER → its edge). A slot position from
  // logicalToCoordinate is the bar CENTER, so a span that runs startKey→endKey by center is
  // short by half a bar at EACH end; we widen the rect by half a bar on each side to cover
  // the full session span (start-of-first-slot → end-of-last-slot). Prefer the public
  // barSpacing() seam; fall back to measuring one logical unit's pixel width (so a stub time
  // scale without barSpacing still widens correctly), then 0 if neither is placeable.
  function halfBarAt(key: number): number {
    const ts = geom.timeScale();
    const bs = (ts as unknown as { barSpacing?: () => number }).barSpacing;
    if (typeof bs === 'function') {
      const v = bs.call(ts);
      if (Number.isFinite(v) && v > 0) return v / 2;
    }
    // Measure one logical unit around this key's slot via logicalToCoordinate.
    const logical = ts.keyToLogical(key, { extrapolate: true });
    if (logical === null) return 0;
    const lg = logical as unknown as number;
    const x0 = ts.logicalToCoordinate(lg);
    const x1 = ts.logicalToCoordinate(lg + 1);
    if (x0 === null || x1 === null) return 0;
    return Math.abs((x1 as unknown as number) - (x0 as unknown as number)) / 2;
  }

  function build(): void {
    const height = geom.paneHeight();
    if (spans.length === 0 || height <= 0) {
      cachedPane = EMPTY;
      cachedAxis = EMPTY;
      return;
    }
    const opts = getOptions();
    // --- the BelowSeries pane band: one rect per span (S5) --------------------------
    builder.reset();
    builder.beginList('media');
    const rects = builder.rects({});
    for (const s of spans) {
      const x0 = xOf(s.startKey);
      const x1 = xOf(s.endKey);
      if (x0 === null || x1 === null) continue;
      // Widen by half a bar-spacing at EACH end: xOf gives the slot CENTER, so the raw
      // center→center span is short by ~one bar. Cover start-of-first-slot → end-of-last-slot.
      const halfL = halfBarAt(s.startKey);
      const halfR = halfBarAt(s.endKey);
      const lo = Math.min(x0, x1) - halfL;
      const hi = Math.max(x0, x1) + halfR;
      const w = Math.max(0, hi - lo);
      rects.quad(lo, 0, w, height, opts.color);
    }
    cachedPane = builder.finish();

    // --- the time-axis break ticks: a tiny rect at each session OPEN boundary (S5) ---
    // The OPEN boundary is the LEFT edge of the first in-session slot (start-of-slot), not
    // its center — shift left by half a bar so the tick sits where the session begins.
    if (opts.showBreaks) {
      axisBuilder.reset();
      axisBuilder.beginList('media');
      const ticks = axisBuilder.rects({});
      for (const s of spans) {
        const x = xOf(s.startKey);
        if (x === null) continue;
        ticks.quad(x - halfBarAt(s.startKey), 0, 1, 6, opts.breakColor);
      }
      cachedAxis = axisBuilder.finish();
    } else {
      cachedAxis = EMPTY;
    }
  }

  // The pane source recomputes spans + geometry on a visible-range / option / spec change.
  const range = (): string => {
    const r = geom.timeScale().getVisibleLogicalRange();
    return r === null ? 'null' : `${r.from},${r.to}`;
  };

  const pane: SceneSource = {
    zBand: ZBand.BelowSeries, // under all series by BAND (design 05 §2.7 / §7.1)
    update(_frame: ViewFrame): void {
      const next = `${getRev()}|${range()}|${geom.paneHeight()}`;
      if (next === sig) return;
      sig = next;
      spans = computeSpans();
      build();
    },
    displayLists: () => cachedPane,
  };
  const axis: SceneSource = {
    zBand: ZBand.BelowSeries,
    update(_frame: ViewFrame): void {
      // the pane source owns the recompute (it runs first per frame); axis just serves.
    },
    displayLists: () => cachedAxis,
  };
  return { pane, axis };
}

/** A minimal pane-size reader (the public IPane.size() slice the source needs). */
interface PaneLike {
  size(): { width: number; height: number };
}

/**
 * Attach a session-highlighting primitive to `pane` on `chart` (design 05 §7.1). `chart`
 * supplies the time scale (keysInRange / keyToLogical / logicalToCoordinate — `ISeries`/
 * `IPane` alone expose no time scale). Returns the §12.4 adapter handle ({ detach,
 * applyOptions } + setSession). Registers TWO sources (S5): a BelowSeries pane band of
 * per-session rects and a time-axis source of break ticks. Auto-detach (pane removal /
 * chart.dispose) funnels through the same idempotent teardown; `detached()` drops the
 * captured context.
 */
export function createSessionHighlight(
  chart: { timeScale(): ITimeScale },
  pane: PrimitiveTarget & PaneLike,
  spec?: SessionSpec,
  options?: DeepPartial<SessionHighlightOptions>,
): SessionHighlightHandle {
  let opts: SessionHighlightOptions = resolve(options);
  let session: SessionSpec | null = spec ?? null;
  let rev = 0;

  let ctx: PrimitiveContext | null = null;
  const geom: Geom = {
    timeScale: () => chart.timeScale(),
    paneHeight: () => (((ctx?.pane as unknown as PaneLike | undefined) ?? pane).size().height),
  };
  const { pane: paneSource, axis: axisSource } = createSessionSource(
    geom,
    () => opts,
    () => session,
    () => rev,
  );

  const primitive: IPrimitive = {
    attached(c): void {
      ctx = c as unknown as PrimitiveContext;
    },
    detached(): void {
      ctx = null;
    },
    sources(): readonly PrimitiveSource[] {
      return [
        { target: 'pane', source: paneSource } as unknown as PrimitiveSource,
        { target: 'time-axis', source: axisSource } as unknown as PrimitiveSource,
      ];
    },
  };

  return createPrimitiveAdapter<SessionHighlightOptions, { setSession(spec: SessionSpec): void }>({
    target: pane,
    primitive,
    options: opts,
    defaults: sessionHighlightDefaults,
    onChange(next): void {
      opts = next;
      rev++;
      ctx?.requestUpdate('render'); // a BelowSeries base-layer band → a Render frame
    },
    methods: {
      setSession(next: SessionSpec): void {
        session = next;
        rev++;
        ctx?.requestUpdate('render');
      },
    },
  });
}

/** Merge the initial patch over the kept defaults (standard §5.1 shallow resolve). */
function resolve(patch?: DeepPartial<SessionHighlightOptions>): SessionHighlightOptions {
  if (patch === undefined) return { ...sessionHighlightDefaults };
  return {
    visible: patch.visible ?? sessionHighlightDefaults.visible,
    color: (patch.color as string) ?? sessionHighlightDefaults.color,
    showBreaks: patch.showBreaks ?? sessionHighlightDefaults.showBreaks,
    breakColor: (patch.breakColor as string) ?? sessionHighlightDefaults.breakColor,
  };
}
