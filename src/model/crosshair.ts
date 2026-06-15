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
 *  (study 07 §4.8). Single-value series (Line/Area/Baseline) pass the same value
 *  in all four slots, so Close and OHLC snapping both land on the datapoint.
 *
 *  `priceToCoordinate` is OPTIONAL: when present it is the *series' own* price
 *  scale (study 07 §4.8: `series.priceScale.priceToCoordinate(bar[key])`), so an
 *  overlay on a secondary scale competes fairly with the pane's default-scale
 *  series — everything is compared in pixel space (§4.8 final note). When absent,
 *  the candidate's values are assumed to live on the pane's default scale and the
 *  shared `MagnetSnapArgs.priceToCoordinate` is used (the common single-scale
 *  pane). A candidate value of `NaN` (the series has no bar at the hovered index,
 *  or a gap) is skipped — never snapped to (study 07 §5: "no datum at index"). */
export interface MagnetCandidate {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly priceToCoordinate?: (price: number) => number;
}

/** Pixel-space conversions for the pane's DEFAULT price scale — supplied by the
 *  host pipeline so the model stays free of geometry ownership (study 07 §3.5).
 *  `priceToCoordinate` maps the pointer price (and any default-scale candidate) to
 *  Y; `coordinateToPrice` converts the WINNING Y back to a default-scale price so
 *  the re-derived crosshair y in §3.5 reproduces exactly that Y (§4.8 final note). */
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

/** Magnet snap (study 07 §4.8 + the §5 gotchas — M11 parity).
 *
 *  Pure model logic: given the raw pointer `price` (already on the pane's default
 *  scale) and the nearby series' candidate values, compute the SNAPPED default-scale
 *  price the host will feed back through §3.5. The four modes are the const-object
 *  union: `Normal`/`Hidden` never snap (price passes through); `Magnet` snaps to the
 *  nearest series DATAPOINT (Close key only); `MagnetOHLC` snaps to the nearest OHLC
 *  LEVEL (open/high/low/close).
 *
 *  Comparison is in PIXEL space (study 07 §4.8 final note): each candidate value is
 *  mapped to Y through its OWN scale (`MagnetCandidate.priceToCoordinate`) when given,
 *  else the pane default `priceToCoordinate`, so series on different price scales
 *  compete fairly. The winning Y is converted back through the pane's default scale
 *  (`coordinateToPrice`) so the re-derived crosshair y reproduces exactly that Y.
 *
 *  Pass-through cases (price returned unchanged, study 07 §4.8 / §5):
 *   • mode is not a magnet mode,
 *   • no candidates,
 *   • the pointer `price` / its `targetY` is NaN (empty default scale — NaN survives
 *     the pipeline and simply hides the horizontal line, §5),
 *   • every candidate value is NaN (no series has a datum at the hovered index, §5). */
export function magnetSnapPrice(args: MagnetSnapArgs): number {
  const { mode, price, candidates, priceToCoordinate, coordinateToPrice } = args;
  if (mode !== CrosshairMode.Magnet && mode !== CrosshairMode.MagnetOHLC) return price;
  if (candidates.length === 0) return price;

  const targetY = priceToCoordinate(price);
  // Empty default scale → NaN pointer Y has no meaningful nearest; NaN survives (§5).
  if (!Number.isFinite(targetY)) return price;

  const ohlc = mode === CrosshairMode.MagnetOHLC;
  let bestY = Number.NaN;
  let bestDist = Number.POSITIVE_INFINITY;

  const consider = (value: number, toY: (p: number) => number): void => {
    if (!Number.isFinite(value)) return; // no datum at index / gap — never snap to it (§5)
    const y = toY(value);
    if (!Number.isFinite(y)) return; // candidate scale empty — skip (§4.8 "own scale empty")
    const d = Math.abs(y - targetY);
    if (d < bestDist) {
      bestDist = d;
      bestY = y;
    }
  };

  for (const c of candidates) {
    // The series' own scale (overlay on a secondary scale) or the pane default (§4.8).
    const toY = c.priceToCoordinate ?? priceToCoordinate;
    if (ohlc) {
      consider(c.open, toY);
      consider(c.high, toY);
      consider(c.low, toY);
    }
    consider(c.close, toY);
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
