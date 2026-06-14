// views/series/grid.ts — the Grid SceneSource (design 01 §6 band Grid; design 03
// §8.5.7; crisp math study 05 §4.4). Reads the time-scale tick X coords + price-
// scale tick Y coords (media px, fed from model geometry) and emits ONE bitmap
// polyline per orientation: a vertical line at each tick X spanning the bitmap
// height and a horizontal line at each tick Y spanning the width, both overdrawn
// one line width past their ends so dash patterns never clip at the border.
// It is a SceneSource (zBand Grid): update(frame) rebuilds only when dirtied (a
// scale change calls setTicks) or when the frame's crisp inputs (hr/vr/bitmap
// size) move; displayLists() returns the IDENTICAL cached array while clean
// (the per-source cache-identity rule, perf §4.4.2 / pane-scene.ts).
import { DisplayListBuilder, LineStyle, ZBand, crispStrokePos, crispWidth } from '../../gfx';
import type { DisplayList, ViewFrame } from '../../gfx';
import type { GridOptions } from '../../model';

/** One side of the grid (study 06 §4.17 / design 02 §6.3 GridOptions side). */
export interface GridSideStyle {
  readonly color: string;
  readonly visible: boolean;
  /** Media-px line width (default 1). */
  readonly lineWidth: number;
  /** Dash style (default Solid). */
  readonly lineStyle: LineStyle;
}

/** Resolve a `GridOptions` side into the styled, defaulted form emit consumes. */
function resolveSide(s: { color: string; visible: boolean; lineWidth?: number; lineStyle?: LineStyle }): GridSideStyle {
  return { color: s.color, visible: s.visible, lineWidth: s.lineWidth ?? 1, lineStyle: s.lineStyle ?? LineStyle.Solid };
}

/** The Grid scene source: a band-Grid `SceneSource` plus the owner-facing
 *  `setTicks` (called on a scale change — the only dirty trigger, design 01 §6). */
export interface GridSource {
  readonly zBand: ZBand;
  update(frame: ViewFrame): void;
  displayLists(): readonly DisplayList[];
  /** Feed the latest tick coords (media px) from both scales; marks dirty so the
   *  next `update` re-emits. `vertX` are time-scale tick X; `horzY` price-scale Y. */
  setTicks(vertX: readonly number[], horzY: readonly number[]): void;
}

/**
 * Build a Grid scene source from the chart's `GridOptions`. The source is stateful:
 * it holds the last tick coords + the last frame's crisp inputs, and caches the
 * emitted lists until either changes (dirty), so a clean re-`displayLists()` hands
 * back the byte-identical array reference (perf §4.4.2).
 */
export function createGridSource(options: GridOptions): GridSource {
  const vert = resolveSide(options.vertLines);
  const horz = resolveSide(options.horzLines);

  let vertX: readonly number[] = [];
  let horzY: readonly number[] = [];
  let dirty = true;
  // Last crisp inputs — a change in any re-derives the device positions.
  let lastHr = Number.NaN;
  let lastVr = Number.NaN;
  let lastBw = Number.NaN;
  let lastBh = Number.NaN;
  let cached: readonly DisplayList[] = EMPTY;

  function setTicks(nextVertX: readonly number[], nextHorzY: readonly number[]): void {
    vertX = nextVertX;
    horzY = nextHorzY;
    dirty = true;
  }

  function update(frame: ViewFrame): void {
    const { hr, vr, bitmapSize } = frame.frame;
    const bw = bitmapSize.width;
    const bh = bitmapSize.height;
    if (!dirty && hr === lastHr && vr === lastVr && bw === lastBw && bh === lastBh) return;
    lastHr = hr;
    lastVr = vr;
    lastBw = bw;
    lastBh = bh;
    dirty = false;
    cached = build(vert, horz, vertX, horzY, hr, vr, bw, bh);
  }

  function displayLists(): readonly DisplayList[] {
    return cached;
  }

  return { zBand: ZBand.Grid, update, displayLists, setTicks };
}

/** The frozen empty list, returned by reference until the first non-empty build. */
const EMPTY: readonly DisplayList[] = Object.freeze([]);

/**
 * Emit the grid: ONE bitmap polyline per orientation (design 03 §8.5.7). Each
 * vertical line is two crisp vertices (top/bottom) then a pen-up gap; positions via
 * `crispStrokePos(coord, ratio, lineBitmapWidth)` (study 05 §4.4 odd-width shift),
 * width `crispWidth(lineWidth, ratio)`, single colour run. Lines overdraw both ends
 * by one line width so dashes don't clip at the border. A side with no visible ticks
 * contributes no list — keeping a side hidden truly emits nothing.
 */
function build(
  vert: GridSideStyle,
  horz: GridSideStyle,
  vertX: readonly number[],
  horzY: readonly number[],
  hr: number,
  vr: number,
  bw: number,
  bh: number,
): readonly DisplayList[] {
  // A fresh builder per rebuild: its pooled arrays back the returned lists and must
  // stay valid while this build is the cache (a reused builder's reset would alias the
  // prior cache). Rebuilds are dirty-gated, so this is not a hot path.
  const out = new DisplayListBuilder();
  out.beginList('bitmap');
  let drew = false;
  // Vertical lines: crisp X via hr; full bitmap height ±overdraw (= one line width w).
  if (vert.visible && vertX.length > 0) {
    const w = crispWidth(vert.lineWidth, hr);
    const poly = out.polyline(w, vert.lineStyle, 'miter');
    for (let i = 0; i < vertX.length; i++) {
      const x = crispStrokePos(vertX[i]!, hr, w);
      poly.vertex(x, -w, vert.color);
      poly.vertex(x, bh + w, vert.color);
      poly.gap();
    }
    drew = true;
  }
  // Horizontal lines: crisp Y via vr; full bitmap width ±overdraw.
  if (horz.visible && horzY.length > 0) {
    const w = crispWidth(horz.lineWidth, vr);
    const poly = out.polyline(w, horz.lineStyle, 'miter');
    for (let i = 0; i < horzY.length; i++) {
      const y = crispStrokePos(horzY[i]!, vr, w);
      poly.vertex(-w, y, horz.color);
      poly.vertex(bw + w, y, horz.color);
      poly.gap();
    }
    drew = true;
  }
  if (!drew) return EMPTY;
  return out.finish();
}
