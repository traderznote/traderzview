// traderzview · extras — up-down (price-change) markers (design 05 §2.7 item 2;
// study 08 §4.7 is the spec of record). A series-attached IPrimitive over the PUBLIC
// api seams only (arch §3.1: api/gfx/core, never model/views). It proxies setData/
// update through itself so it can diff each update against the previously managed
// value for a time key and auto-create a direction marker (sign −1/0/+1) coloured by
// the change. Expiry is the design 05 §2.7 mechanism — NOT a per-marker setTimeout
// army: a LAZY sweep against frame.now in SceneSource.update plus EXACTLY ONE
// adapter-owned setTimeout re-armed to the soonest pending expiresAt; its callback
// calls ctx.requestUpdate('render') (markers sit on the AboveSeries base-layer band)
// so an idle chart still runs the sweep; detached() clears the timer (§2.2 lifecycle).
import { crispRound, crispWidth, ZBand } from '../../gfx';
import type { DisplayList, SceneSource, ViewFrame } from '../../gfx';
import type { DeepPartial } from '../../core';
import { DisplayListBuilder } from '../../gfx';
import { createPrimitiveAdapter } from '../shared';
import type { PrimitiveAdapter, PrimitiveTarget } from '../shared';
import type { IPrimitive, PrimitiveContext } from '../../api';

// Renderer constants kept verbatim from the reference (study 08 §4.7).
const RADIUS = 4;
const ARROW_SIZE = 4.7; // chevron half-width
const ARROW_OFFSET = 7; // chevron centre offset above the dot
const ARROW_LINE_WIDTH = 2; // chevron stroke width (media px)
const POSITIVE = '#22AB94';
const NEGATIVE = '#F7525F';
const DEFAULT_DURATION = 5000; // ms; 0 = stay until the next update

/** Sign of a price change: 0 equal, +1 up, −1 down (study 08 §4.7). */
export type UpDownSign = -1 | 0 | 1;

/** A managed/visible direction marker — the public {time, value, sign} item (§4.16). */
export interface UpDownMarker<H = unknown> {
  time: H;
  value: number;
  sign: UpDownSign;
}

/** Up-down marker options (study 09 §4.16). */
export interface UpDownMarkersOptions {
  positiveColor: string;
  negativeColor: string;
  /** ms a change marker stays visible; 0 = until the next update (no expiry). */
  updateVisibilityDuration: number;
}

export const upDownMarkersDefaults: UpDownMarkersOptions = {
  positiveColor: POSITIVE,
  negativeColor: NEGATIVE,
  updateVisibilityDuration: DEFAULT_DURATION,
};

/** The factory-specific handle methods (study 09 §4.16). */
export interface UpDownMarkersMethods<H = unknown> {
  /** Replace ALL managed points (the data feed) — proxied to the series. */
  setData(items: readonly { time: H; value?: number }[]): void;
  /** Push one item; an update to an already-managed time auto-creates a direction marker. */
  update(item: { time: H; value?: number }, historicalUpdate?: boolean): void;
  /** Snapshot of the currently-visible (non-expired) markers, in time order. */
  markers(): readonly UpDownMarker<H>[];
  /** Manual mode: replace all markers directly (no expiry, no series proxy). */
  setMarkers(markers: readonly UpDownMarker<H>[]): void;
  /** Drop every marker. */
  clearMarkers(): void;
}

export type UpDownMarkersHandle<H = unknown> = PrimitiveAdapter<
  UpDownMarkersOptions,
  UpDownMarkersMethods<H>
>;

// The minimal slice of ISeries this plugin reaches over the public seam: it attaches,
// reads the neutral colour from options, converts price→coordinate, and forwards the
// data feed. Series is the PrimitiveTarget too (attach/detachPrimitive).
interface SeriesLike extends PrimitiveTarget {
  setData(items: readonly unknown[]): void;
  update(item: unknown, options?: { historical?: boolean }): void;
  options(): { color?: string; lineColor?: string };
  priceToCoordinate(price: number): number | null;
  seriesType?(): string;
}

/** A managed entry: its value (for sign diff + drawing) + sign + expiry instant. */
interface Managed<H> {
  time: H;
  value: number;
  sign: UpDownSign;
  /** Absolute clock instant (same base as frame.now) the marker expires at; +∞ = never. */
  expiresAt: number;
}

/** Stable identity for a time value over the public seam (no behavior.key access). */
function keyOf(time: unknown): string {
  if (time !== null && typeof time === 'object') {
    const bd = time as { year?: number; month?: number; day?: number };
    return `${bd.year}-${bd.month}-${bd.day}`;
  }
  return String(time);
}

/**
 * createUpDownMarkers(series, options?) — the design 02 §12.4 adapter. Attaches on
 * construction (the adapter schedules the first Render frame); returns the standard
 * `{ detach, applyOptions }` plus the §4.16 data/marker methods. Series types are
 * Line and Area only (the neutral colour is `color`/`lineColor` respectively).
 */
export function createUpDownMarkers<H = unknown>(
  series: SeriesLike,
  options?: DeepPartial<UpDownMarkersOptions>,
): UpDownMarkersHandle<H> {
  // Resolved live options (the adapter owns the §5.1 merge; we keep a mutable mirror).
  let opts: UpDownMarkersOptions = { ...upDownMarkersDefaults, ...stripUndefined(options) };

  // The expiring manager: key → managed entry. Insertion-time iteration gives us the
  // ascending-by-time order the feed arrives in (setData/update append in time order).
  const managed = new Map<string, Managed<H>>();

  // Lifecycle wiring filled in at attach(); a no-op clock until then keeps detach safe.
  let ctx: PrimitiveContext<H> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // The clock the sweep + timer share. In the host frame.now is performance.now(); the
  // adapter arms setTimeout against the SAME base so a delay is expiresAt − now.
  let clock: () => number = nowClock;

  const source = new UpDownSource<H>(managed, () => series, () => opts);

  // --- the expiry timer: ONE setTimeout, re-armed to the soonest pending expiresAt ----
  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function rearm(): void {
    clearTimer();
    let soonest = Infinity;
    for (const m of managed.values()) {
      if (m.expiresAt < soonest) soonest = m.expiresAt;
    }
    if (soonest === Infinity) return; // nothing expires — no timer (idle is free)
    const delay = Math.max(0, soonest - clock());
    timer = setTimeout(() => {
      timer = null;
      // The frame this requests runs SceneSource.update, whose sweep drops expired
      // entries against frame.now; after that frame the source re-arms via onSweep.
      ctx?.requestUpdate('render');
    }, delay);
  }

  // Called by the source after each sweep so the timer tracks the new soonest expiry.
  source.onSweep = rearm;

  // --- diff one feed item against its managed predecessor → a direction marker --------
  // `seed` (the setData replace path) never makes a marker or an expiry, so the caller
  // batches dirty()/rearm() once after the loop (no O(n²) per-item re-arm).
  function ingest(time: H, value: number | undefined, seed: boolean): void {
    const k = keyOf(time);
    const prev = managed.get(k);
    if (value === undefined) {
      managed.delete(k); // whitespace update deletes the managed point (study 08 §4.7)
      return;
    }
    let sign: UpDownSign = 0;
    let expiresAt = Infinity;
    if (prev !== undefined && !seed) {
      // A marker is created ONLY for an update to an already-managed time (§4.16/§4.7).
      sign = value > prev.value ? 1 : value < prev.value ? -1 : 0;
      const d = opts.updateVisibilityDuration;
      expiresAt = d > 0 ? clock() + d : Infinity;
    }
    managed.set(k, { time, value, sign, expiresAt });
  }

  const methods: UpDownMarkersMethods<H> = {
    setData(items): void {
      managed.clear();
      for (const it of items) ingest(it.time, it.value, true);
      source.dirty();
      rearm();
      series.setData(items as readonly unknown[]);
    },
    update(item, historicalUpdate): void {
      ingest(item.time, item.value, false);
      source.dirty();
      rearm();
      series.update(item, { historical: historicalUpdate ?? false });
    },
    markers(): readonly UpDownMarker<H>[] {
      const now = clock();
      const out: UpDownMarker<H>[] = [];
      for (const m of managed.values()) {
        if (m.expiresAt <= now) continue; // lazy drop on read (study 08 §4.7)
        out.push({ time: m.time, value: m.value, sign: m.sign });
      }
      return out;
    },
    setMarkers(next): void {
      managed.clear();
      for (const m of next) managed.set(keyOf(m.time), { ...m, expiresAt: Infinity });
      source.dirty();
      rearm();
      ctx?.requestUpdate('render');
    },
    clearMarkers(): void {
      managed.clear();
      clearTimer();
      source.dirty();
      ctx?.requestUpdate('render');
    },
  };

  // The wrapped primitive: one source on AboveSeries; lifecycle wires the context.
  const primitive: IPrimitive = {
    attached(c): void {
      ctx = c as unknown as PrimitiveContext<H>;
      clock = nowClock;
      source.bindContext(ctx);
      rearm();
    },
    detached(): void {
      clearTimer();
      ctx = null;
    },
    sources(): readonly { target: 'pane'; source: SceneSource }[] {
      return [{ target: 'pane', source }];
    },
  };

  return createPrimitiveAdapter<UpDownMarkersOptions, UpDownMarkersMethods<H>>({
    target: series,
    primitive,
    options: opts,
    defaults: upDownMarkersDefaults,
    onChange(next): void {
      opts = next;
      source.dirty();
      ctx?.requestUpdate('render');
    },
    methods,
    onDetach(): void {
      clearTimer();
    },
  });
}

/** Drop undefined leaves from a partial so `{...defaults, ...patch}` does not clobber. */
function stripUndefined(o?: DeepPartial<UpDownMarkersOptions>): Partial<UpDownMarkersOptions> {
  if (o === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<UpDownMarkersOptions>;
}

/** performance.now() when present (the host frame clock), else Date.now(). */
function nowClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

// --- the SceneSource: bitmap-space dot + chevron, with the lazy expiry sweep ----------

interface CoordProvider {
  priceToCoordinate(price: number): number | null;
  options(): { color?: string; lineColor?: string };
  seriesType?(): string;
}

class UpDownSource<H> implements SceneSource {
  readonly zBand = ZBand.AboveSeries; // above series, below the crosshair (design 05 §2.3)
  /** Re-arm hook set by the factory: called after each sweep that DROPPED an entry. */
  onSweep: (() => void) | null = null;

  #managed: Map<string, Managed<H>>;
  #series: () => CoordProvider;
  #opts: () => UpDownMarkersOptions;
  #ctx: PrimitiveContext<H> | null = null;
  #lists: readonly DisplayList[] = [];
  #dirty = true;
  #builder = new DisplayListBuilder();

  constructor(
    managed: Map<string, Managed<H>>,
    series: () => CoordProvider,
    opts: () => UpDownMarkersOptions,
  ) {
    this.#managed = managed;
    this.#series = series;
    this.#opts = opts;
  }

  bindContext(ctx: PrimitiveContext<H>): void {
    this.#ctx = ctx;
    this.#dirty = true;
  }

  dirty(): void {
    this.#dirty = true;
  }

  update(frame: ViewFrame): void {
    // 1) LAZY sweep against frame.now — drop expired entries (study 08 §4.7).
    let dropped = false;
    for (const [k, m] of this.#managed) {
      if (m.expiresAt <= frame.now) {
        this.#managed.delete(k);
        dropped = true;
      }
    }
    if (dropped) {
      this.#dirty = true;
      this.onSweep?.(); // re-arm the single timer to the new soonest expiry
    }
    if (!this.#dirty) return;
    this.#rebuild(frame);
    this.#dirty = false;
  }

  displayLists(): readonly DisplayList[] {
    return this.#lists;
  }

  #rebuild(frame: ViewFrame): void {
    const { hr, vr } = frame.frame;
    const ts = this.#ctx?.chart.timeScale() as
      | { timeToCoordinate(time: H): number | null }
      | undefined;
    const series = this.#series();
    const opts = this.#opts();
    const neutral = this.#neutralColor(series);

    // markers bitmap correction = (max(1,floor(hr)) % 2)/2 (study 08 §4.4 rounding).
    const tickW = crispWidth(1, hr);
    const corr = (tickW % 2) / 2;
    const radius = RADIUS * vr + corr;
    const chevronW = Math.max(1, Math.floor(ARROW_LINE_WIDTH * hr));

    const b = this.#builder;
    b.reset();
    b.beginList('bitmap');

    const circles = b.circles();
    type Chevron = { sx: number; ey: number; ax: number; ay: number; bx: number; color: string };
    const chevrons: Chevron[] = [];

    for (const m of this.#managed.values()) {
      const x = ts?.timeToCoordinate(m.time) ?? null;
      // x null is an unrecoverable layout error in the reference (assertion); we skip
      // defensively (a headless stub may have no timescale) — the dot is just dropped.
      if (x === null) continue;
      const y = series.priceToCoordinate(m.value);
      if (y === null) continue; // silently drop (study 08 §4.7)

      const cx = crispRound(x, hr) + corr;
      const cy = y * vr; // y is NOT rounded (study 08 §4.4)
      const color = m.sign > 0 ? opts.positiveColor : m.sign < 0 ? opts.negativeColor : neutral;
      circles.circle(cx, cy, radius, color);

      if (m.sign !== 0) {
        // chevron above the dot: (x−4.7, y−7s) → (x, y−7s−3.5s) → (x+4.7, y−7s)
        const baseY = (y - ARROW_OFFSET * m.sign) * vr;
        chevrons.push({
          sx: crispRound(x - ARROW_SIZE, hr) + corr,
          ey: baseY,
          ax: cx,
          ay: (y - ARROW_OFFSET * m.sign - (ARROW_OFFSET / 2) * m.sign) * vr,
          bx: crispRound(x + ARROW_SIZE, hr) + corr,
          color,
        });
      }
    }

    for (const c of chevrons) {
      const p = b.path(undefined, { width: chevronW, color: c.color });
      p.move(c.sx, c.ey);
      p.line(c.ax, c.ay);
      p.line(c.bx, c.ey);
    }

    this.#lists = b.finish();
  }

  #neutralColor(series: CoordProvider): string {
    const o = series.options();
    // Area's neutral is lineColor; Line's is color (study 08 §4.7). Fall back across both.
    return o.lineColor ?? o.color ?? POSITIVE;
  }
}
