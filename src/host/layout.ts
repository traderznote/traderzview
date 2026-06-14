// traderzview · host/layout — the one pure Hi-DPI layout function. Turns a chart
// size + pane stretch factors + measured axis widths into the media-px rect of
// every surface (panes, L/R price axes, time axis, corner stubs, separators).
// No DOM, no globals: the host applies these rects to elements/surfaces.
// Encodes design 01 §7 + study 10 §3.1 (measure-all-then-apply, model-width-last).
import { assert } from '../core';
import type { Rect, Size } from '../core';

/** A pane row: the pane body plus its left/right price-axis surfaces. Heights
 *  agree across the three; the model width that follows layout is `pane.width`. */
export interface PaneRects {
  readonly pane: Rect;
  readonly leftAxis: Rect | null;
  readonly rightAxis: Rect | null;
}

/** Measured (un-rounded) axis dimensions fed in from the views axis-layout pass.
 *  Width 0 / hidden ⇒ that side's surface is omitted (rect null). */
export interface AxisWidths {
  readonly left: number; // 0 ⇒ no left price axis
  readonly right: number; // 0 ⇒ no right price axis
}

/** Every rect a SurfaceHost needs, in media (CSS) px. `paneWidth` is the model
 *  width — applied LAST by the host (study 10 §3.1 step 7). `chartSize` is the
 *  even-floored outer size actually used (≤ the requested size). */
export interface LayoutRects {
  readonly chartSize: Size; // even-floored size actually laid out
  readonly paneWidth: number; // model width, set last
  readonly panes: readonly PaneRects[];
  readonly timeAxis: Rect | null; // null when timeAxisHeight resolves to 0
  readonly leftStub: Rect | null; // bottom-left corner under the left axis
  readonly rightStub: Rect | null; // bottom-right corner under the right axis
  readonly separators: readonly Rect[]; // 1-px rows between consecutive panes
}

const MIN_PANE_PX = 2; // 2-px pane-height floor (study 10 §3.1 step 5)

/** Floor, then force even by dropping the odd bit — the outer chart box (study
 *  10 §3.1: "floored then forced even"). Keeps CSS px × DPR integral both axes. */
function evenDown(v: number): number {
  const f = Math.max(0, Math.floor(v));
  return f - (f % 2);
}

/** Round up, then force even by adding one if odd — axis widths + time-axis
 *  height (study 10 §3.1 step 3 / step 4 "even(...)", round up). */
function evenUp(v: number): number {
  if (v <= 0) return 0;
  const c = Math.ceil(v);
  return c % 2 === 0 ? c : c + 1;
}

/** Device-pixel quantize: round to a whole device pixel then back to media px,
 *  so `height × dpr` is integral and the canvas never resamples (§3.1 step 5). */
function quantize(mediaPx: number, dpr: number): number {
  return Math.round(mediaPx * dpr) / dpr;
}

/** The PURE layout function (design 01 §7, study 10 §3.1). MEASURE-ALL-THEN-APPLY:
 *  axis widths are even'd once up front (each side is already the max across panes
 *  at the call site), pane heights are then distributed in device pixels with the
 *  last pane ceil-absorbing the remainder, every height floored at 2 px. The
 *  returned `paneWidth` is the model width the host applies strictly last.
 *
 *  @param chartSize        requested outer size (media px); even-floored internally.
 *  @param stretchFactors   per-pane stretch weights, top→bottom; >0 each.
 *  @param axisWidths       measured L/R price-axis widths (media px); 0 ⇒ omitted.
 *  @param timeAxisHeight   measured time-axis height (media px); 0 ⇒ no time axis.
 *  @param dpr              device pixel ratio (>0); fractional is normal.
 */
export function computeLayout(
  chartSize: Size,
  stretchFactors: readonly number[],
  axisWidths: AxisWidths,
  timeAxisHeight: number,
  dpr: number,
): LayoutRects {
  if (__DEV__) {
    assert(stretchFactors.length > 0, 'computeLayout: need at least one pane');
    assert(dpr > 0, 'computeLayout: dpr must be > 0');
    assert(
      stretchFactors.every((s) => s > 0),
      'computeLayout: stretch factors must be > 0',
    );
  }

  // 1. Outer box: floor then force even on both axes.
  const width = evenDown(chartSize.width);
  const height = evenDown(chartSize.height);

  // 2. Axis widths even-up (round up to even); 0 ⇒ that side is absent.
  const leftW = evenUp(axisWidths.left);
  const rightW = evenUp(axisWidths.right);

  // 3. Time-axis height even-up; 0 ⇒ no time-axis row / stubs.
  const taH = evenUp(timeAxisHeight);

  // 4. Derived geometry. Separators are 1 media-px rows between consecutive panes.
  const paneWidth = Math.max(width - leftW - rightW, 0);
  const sepCount = stretchFactors.length - 1;
  const totalPaneHeight = Math.max(height - taH - sepCount, 0);
  const totalStretch = stretchFactors.reduce((a, s) => a + s, 0);
  const pxPerStretch = totalStretch > 0 ? totalPaneHeight / totalStretch : 0;

  // 5. Apply pass, pane by pane. Each pane height is device-pixel quantized; the
  //    LAST pane ceil-absorbs whatever remains so the rows sum exactly to
  //    totalPaneHeight. A separator (1 px) sits before every pane after the first.
  const panes: PaneRects[] = [];
  const separators: Rect[] = [];
  const last = stretchFactors.length - 1;
  let cursorY = 0; // top edge of the next pane row
  let accumulated = 0; // device-quantized pane height consumed so far

  for (let i = 0; i < stretchFactors.length; i++) {
    if (i > 0) {
      // 1-px separator row above this pane (full chart width).
      separators.push({ x: 0, y: cursorY, width, height: 1 });
      cursorY += 1;
    }

    let h: number;
    if (i === last) {
      h = Math.ceil((totalPaneHeight - accumulated) * dpr) / dpr;
    } else {
      h = quantize(stretchFactors[i] * pxPerStretch, dpr);
    }
    h = Math.max(h, MIN_PANE_PX);
    accumulated += h;

    const leftAxis: Rect | null =
      leftW > 0 ? { x: 0, y: cursorY, width: leftW, height: h } : null;
    const rightAxis: Rect | null =
      rightW > 0 ? { x: width - rightW, y: cursorY, width: rightW, height: h } : null;
    const pane: Rect = { x: leftW, y: cursorY, width: paneWidth, height: h };

    panes.push({ pane, leftAxis, rightAxis });
    cursorY += h;
  }

  // 6. Time-axis row + corner stubs under the price axes. When hidden, all null.
  let timeAxis: Rect | null = null;
  let leftStub: Rect | null = null;
  let rightStub: Rect | null = null;
  if (taH > 0) {
    const taY = cursorY; // directly below the last pane
    timeAxis = { x: leftW, y: taY, width: paneWidth, height: taH };
    if (leftW > 0) leftStub = { x: 0, y: taY, width: leftW, height: taH };
    if (rightW > 0) rightStub = { x: width - rightW, y: taY, width: rightW, height: taH };
  }

  return {
    chartSize: { width, height },
    paneWidth, // 7. model width — the host applies this LAST.
    panes,
    timeAxis,
    leftStub,
    rightStub,
    separators,
  };
}
