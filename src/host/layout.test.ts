import { describe, expect, test } from 'vitest';
import { computeLayout } from './layout';
import type { LayoutRects } from './layout';

// Golden table: each expected LayoutRects is hand-derived from study 10 §3.1
// (even-floor chart, even-up axis widths/time-axis height, device-pixel pane
// quantization, last-pane ceil-absorbs remainder, 2-px floor) — NOT echoed from
// the impl. dpr is exercised at 1 and 2; sums are checked to close exactly.

describe('computeLayout — golden cases (study 10 §3.1)', () => {
  test('A: single pane, no axes, no time axis, dpr=1', () => {
    const got = computeLayout({ width: 800, height: 600 }, [1], { left: 0, right: 0 }, 0, 1);
    const want: LayoutRects = {
      chartSize: { width: 800, height: 600 },
      paneWidth: 800,
      panes: [{ pane: { x: 0, y: 0, width: 800, height: 600 }, leftAxis: null, rightAxis: null }],
      timeAxis: null,
      leftStub: null,
      rightStub: null,
      separators: [],
    };
    expect(got).toEqual(want);
  });

  test('B: odd chart + odd left axis + time axis, two equal panes, dpr=1', () => {
    // 801→800, 603→602 (even-floor); left 51→52 (even-up); taH 29→30 (even-up).
    // paneWidth = 800-52 = 748. totalPaneHeight = 602-30-1(sep) = 571; /2 = 285.5.
    // pane0 = round(285.5)=286; pane1(last) = ceil(571-286)=285.
    const got = computeLayout({ width: 801, height: 603 }, [1, 1], { left: 51, right: 0 }, 29, 1);
    const want: LayoutRects = {
      chartSize: { width: 800, height: 602 },
      paneWidth: 748,
      panes: [
        {
          pane: { x: 52, y: 0, width: 748, height: 286 },
          leftAxis: { x: 0, y: 0, width: 52, height: 286 },
          rightAxis: null,
        },
        {
          pane: { x: 52, y: 287, width: 748, height: 285 },
          leftAxis: { x: 0, y: 287, width: 52, height: 285 },
          rightAxis: null,
        },
      ],
      timeAxis: { x: 52, y: 572, width: 748, height: 30 },
      leftStub: { x: 0, y: 572, width: 52, height: 30 },
      rightStub: null,
      separators: [{ x: 0, y: 286, width: 800, height: 1 }],
    };
    expect(got).toEqual(want);
    // Heights close exactly: 286 + 1(sep) + 285 + 30(taH) = 602.
    expect(286 + 1 + 285 + 30).toBe(602);
  });

  test('C: device-pixel quantization + last-pane remainder, dpr=2, both axes', () => {
    // 1000, 401→400. left 60→60, right 61→62. paneWidth = 1000-60-62 = 878.
    // totalPaneHeight = 400-2(seps) = 398; /5 = 79.6.
    // pane0 stretch 3: round(3*79.6*2)/2 = round(477.6)/2 = 478/2 = 239.
    // pane1 stretch 1: round(79.6*2)/2 = round(159.2)/2 = 159/2 = 79.5.
    // pane2(last): ceil((398-318.5)*2)/2 = ceil(159)/2 = 79.5.
    const got = computeLayout(
      { width: 1000, height: 401 },
      [3, 1, 1],
      { left: 60, right: 61 },
      0,
      2,
    );
    const want: LayoutRects = {
      chartSize: { width: 1000, height: 400 },
      paneWidth: 878,
      panes: [
        {
          pane: { x: 60, y: 0, width: 878, height: 239 },
          leftAxis: { x: 0, y: 0, width: 60, height: 239 },
          rightAxis: { x: 938, y: 0, width: 62, height: 239 },
        },
        {
          pane: { x: 60, y: 240, width: 878, height: 79.5 },
          leftAxis: { x: 0, y: 240, width: 60, height: 79.5 },
          rightAxis: { x: 938, y: 240, width: 62, height: 79.5 },
        },
        {
          pane: { x: 60, y: 320.5, width: 878, height: 79.5 },
          leftAxis: { x: 0, y: 320.5, width: 60, height: 79.5 },
          rightAxis: { x: 938, y: 320.5, width: 62, height: 79.5 },
        },
      ],
      timeAxis: null,
      leftStub: null,
      rightStub: null,
      separators: [
        { x: 0, y: 239, width: 1000, height: 1 },
        { x: 0, y: 319.5, width: 1000, height: 1 },
      ],
    };
    expect(got).toEqual(want);
    // Every pane height is integral in device pixels (h*dpr ∈ ℤ).
    for (const p of got.panes) expect(Number.isInteger(p.pane.height * 2)).toBe(true);
    // Heights close exactly: 239 + 79.5 + 79.5 + 2(seps) = 400.
    expect(239 + 79.5 + 79.5 + 2).toBe(400);
  });

  test('D: 2-px floor wins over fit when the last pane would be < 2', () => {
    // 200, 12. no axes. totalPaneHeight = 12-1(sep) = 11; /1001 stretch.
    // pane0 stretch 1000: round(1000*11/1001)=round(10.989)=11.
    // pane1(last): ceil(11-11)=0 → floored to 2. Total overflows (12+2>11): floor wins.
    const got = computeLayout({ width: 200, height: 12 }, [1000, 1], { left: 0, right: 0 }, 0, 1);
    expect(got.panes[0].pane).toEqual({ x: 0, y: 0, width: 200, height: 11 });
    expect(got.panes[1].pane).toEqual({ x: 0, y: 12, width: 200, height: 2 });
    expect(got.separators).toEqual([{ x: 0, y: 11, width: 200, height: 1 }]);
  });
});

describe('computeLayout — structural invariants', () => {
  test('measure-all-then-apply: every pane on a side shares one even width', () => {
    const got = computeLayout({ width: 640, height: 480 }, [1, 1, 1], { left: 41, right: 0 }, 0, 1);
    const widths = new Set(got.panes.map((p) => p.leftAxis?.width));
    expect(widths).toEqual(new Set([42])); // 41 even-up → 42, identical across panes
  });

  test('time-axis hidden ⇒ time axis and both stubs are null', () => {
    const got = computeLayout({ width: 300, height: 200 }, [1], { left: 30, right: 30 }, 0, 1);
    expect(got.timeAxis).toBeNull();
    expect(got.leftStub).toBeNull();
    expect(got.rightStub).toBeNull();
  });

  test('stubs appear under each present axis when the time axis is visible', () => {
    const got = computeLayout({ width: 300, height: 200 }, [1], { left: 30, right: 0 }, 20, 1);
    expect(got.leftStub).toEqual({ x: 0, y: 180, width: 30, height: 20 });
    expect(got.rightStub).toBeNull(); // right axis absent ⇒ no right stub
    expect(got.timeAxis).toEqual({ x: 30, y: 180, width: 270, height: 20 });
  });

  test('paneWidth never goes negative when axes exceed the chart width', () => {
    const got = computeLayout({ width: 80, height: 100 }, [1], { left: 60, right: 60 }, 0, 1);
    expect(got.paneWidth).toBe(0);
    expect(got.panes[0].pane.width).toBe(0);
  });
});
