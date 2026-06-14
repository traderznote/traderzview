// The crosshair model (architecture §4.6 crosshair row; study 07 is the spec of
// record). It holds the crosshair POSITION state (the logical index + price the
// crosshair is at, plus the re-derived applied x/y and the raw origin coords), the
// magnet / snap-to-bar modes, the touch-tracking flag, and the `HoverTarget` that
// the HOST sets from `views` hit-test results.
//
// HARD walls (architecture §3.1 / §5.5): the model NEVER runs hit tests itself and
// NEVER imports gfx. `HoverTarget` uses `core` types ONLY — its `cursor` is the
// `CursorStyle` that lives in `core` (architecture §4.2), so this file imports
// nothing from gfx/views/host. Tracking ENTRY/EXIT + anchor arithmetic live in
// host/input (study 07 §4.13); here we hold only the boolean position state.
import type { Coordinate, CursorStyle, TimeIndex } from '../core';

/** The crosshair snap modes (study 07 §3.7 / §4.8; architecture §4.6).
 *  A const-object union, NOT an enum (erasableSyntaxOnly, M0) — same member-access
 *  shape as `gfx/commands.ts`. String values match the public API (design 02 §6.4):
 *  `'normal' | 'magnet' | 'hidden' | 'magnet-ohlc'`. */
export const CrosshairMode = {
  Normal: 'normal',
  Magnet: 'magnet',
  Hidden: 'hidden',
  MagnetOHLC: 'magnet-ohlc',
} as const;
export type CrosshairMode = (typeof CrosshairMode)[keyof typeof CrosshairMode];

/** The full crosshair position. `index`/`price` are logical; `x`/`y` are the
 *  re-derived APPLIED (bar-snapped / magnet-snapped) media coords; `originX`/
 *  `originY` keep the raw pointer so scroll/zoom can re-snap (study 07 §3.5/§5). */
export interface CrosshairPosition {
  readonly index: TimeIndex;
  readonly price: number; // BarPrice value; NaN when the scale is empty / cleared
  readonly x: Coordinate; // = indexToCoordinate(index); NaN when cleared
  readonly y: Coordinate; // = priceToCoordinate(price); NaN when cleared
  readonly originX: Coordinate; // raw pointer x
  readonly originY: Coordinate; // raw pointer y
}

/** One series' OHLC values at the hovered index — the magnet candidate set
 *  (study 07 §4.8). Single-value series pass the same value in all four slots. */
export interface MagnetCandidate {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/** Pixel-space conversions for one price scale — supplied by the host pipeline so
 *  the model stays free of geometry ownership (study 07 §3.5). */
export interface MagnetConverters {
  priceToCoordinate(price: number): number;
  coordinateToPrice(coordinate: number): number;
}

export interface MagnetSnapArgs extends MagnetConverters {
  readonly mode: CrosshairMode;
  readonly price: number;
  readonly candidates: readonly MagnetCandidate[];
}

/** The hovered-source record the HOST copies in from a `views` hit test
 *  (architecture §5.5). Every field is a `core` type — `cursor` is `CursorStyle`
 *  from `core`, so the model imports nothing from gfx. The model NEVER computes
 *  this; it only stores what the host hands it. */
export interface HoverTarget {
  readonly sourceId: string;
  readonly seriesId?: string;
  readonly externalId?: string;
  readonly cursor?: CursorStyle;
  readonly data?: unknown;
}

/** Magnet snap (study 07 §4.8). Compare candidate Ys to the pointer Y in PIXEL
 *  space (so series on different scales compete fairly), pick the nearest, and
 *  convert the winning Y back through the pane's scale. Normal mode and the empty-
 *  candidate case pass the price through unchanged. */
export function magnetSnapPrice(args: MagnetSnapArgs): number {
  const { mode, price, candidates, priceToCoordinate, coordinateToPrice } = args;
  if (mode !== CrosshairMode.Magnet && mode !== CrosshairMode.MagnetOHLC) return price;
  if (candidates.length === 0) return price;

  const targetY = priceToCoordinate(price);
  const ohlc = mode === CrosshairMode.MagnetOHLC;
  let bestY = Number.NaN;
  let bestDist = Number.POSITIVE_INFINITY;

  const consider = (value: number): void => {
    const y = priceToCoordinate(value);
    const d = Math.abs(y - targetY);
    if (d < bestDist) {
      bestDist = d;
      bestY = y;
    }
  };

  for (const c of candidates) {
    if (ohlc) {
      consider(c.open);
      consider(c.high);
      consider(c.low);
    }
    consider(c.close);
  }

  if (!Number.isFinite(bestY)) return price;
  return coordinateToPrice(bestY);
}

/** Crosshair position state owner (architecture §4.6). */
export class Crosshair {
  #mode: CrosshairMode = CrosshairMode.Magnet; // study 07 §3.7 default
  #position: CrosshairPosition | null = null;
  #visible = false;
  #hover: HoverTarget | null = null;
  #tracking = false;

  mode(): CrosshairMode {
    return this.#mode;
  }
  setMode(mode: CrosshairMode): void {
    this.#mode = mode;
  }

  /** Whether the crosshair has a live (non-cleared) position. */
  visible(): boolean {
    return this.#visible;
  }

  /** Whether the lines/marks should RENDER: visible AND mode is not Hidden.
   *  Hidden suppresses rendering only — position and events still flow
   *  (study 07 §5). */
  renderVisible(): boolean {
    return this.#visible && this.#mode !== CrosshairMode.Hidden;
  }

  /** The current position, or null after a clear against an empty chart. */
  position(): CrosshairPosition | null {
    return this.#position;
  }

  /** Set the crosshair position. The caller (host pipeline, study 07 §3.5) has
   *  already clamped the index into the visible strict range, magnet-aligned the
   *  price (via `magnetSnapPrice`), and re-derived the applied `x`/`y`; this method
   *  only stores the resulting state and marks the crosshair visible. */
  setPosition(position: CrosshairPosition): void {
    this.#position = position;
    this.#visible = true;
  }

  /** Clear the crosshair (study 07 §5): index → the last bar index across ALL
   *  series (keeps the time-axis label meaningful), price/x/y → NaN. A null
   *  `lastBarIndex` (empty chart) drops the position entirely. */
  clear(lastBarIndex: TimeIndex | null): void {
    this.#visible = false;
    if (lastBarIndex === null) {
      this.#position = null;
      return;
    }
    const nan = Number.NaN as unknown as Coordinate;
    this.#position = {
      index: lastBarIndex,
      price: Number.NaN,
      x: nan,
      y: nan,
      originX: nan,
      originY: nan,
    };
  }

  // --- hovered source (set by the host from views hit tests, §5.5) --------------

  hover(): HoverTarget | null {
    return this.#hover;
  }
  setHover(target: HoverTarget | null): void {
    this.#hover = target;
  }

  // --- touch tracking mode (STATE only; entry/exit are host/input, §4.13) -------

  isTracking(): boolean {
    return this.#tracking;
  }
  setTracking(on: boolean): void {
    this.#tracking = on;
  }
}
