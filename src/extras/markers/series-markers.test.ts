// Spec of record: study 08 §4.4 (markers — index resolution via the FIXED nearest-search
// §13.14, sizing, stacking, shape geometry, autoscale margins) + design 05 §2.7 item 1
// (ascending validation, zOrder AboveSeries, real hit distances → HoverInfo.kind:"primitive",
// data-changed teardown in detached) + design 02 §12 / §12.4 (the public IPrimitive seam +
// the {detach, applyOptions} + setMarkers/markers adapter). HEADLESS: stub ISeries / IChart /
// ITimeScale over the PUBLIC api types + a recording attach target; no DOM, no model, no
// browser. Every assertion is hand-derived from those specs.
import { describe, expect, test, vi } from 'vitest';
import { ZBand, HitPriority } from '../../gfx';
import type { DrawCommand, SceneSource, ViewFrame } from '../../gfx';
import type { Coordinate } from '../../core';
import {
  createSeriesMarkers,
  defaultSeriesMarkersOptions,
  type SeriesMarker,
} from './series-markers';

// --- a stub series store: 5 OHLC bars at logical 0..4, times '0'..'4' ---------------
// roles: current=close, min=low, max=high (the OHLC contract). data()[i].time === String(i).
const BARS = [
  { time: '0', open: 10, high: 14, low: 9, close: 13 },
  { time: '1', open: 13, high: 17, low: 12, close: 11 },
  { time: '2', open: 11, high: 12, low: 8, close: 9 },
  { time: '3', open: 9, high: 15, low: 9, close: 14 },
  { time: '4', open: 14, high: 16, low: 13, close: 15 },
];

function makeStore() {
  return {
    length: BARS.length,
    timeIndex: (i: number) => i,
    current: (i: number) => BARS[i].close,
    min: (i: number) => BARS[i].low,
    max: (i: number) => BARS[i].high,
    lane: (_n: number, i: number) => BARS[i].close,
    firstIndexAt: () => null,
    nearestIndexAt: () => 0,
  };
}

// A recording attach target + the ISeries surface markers actually touch. priceToCoordinate
// is a NORMAL (non-inverted) linear map: y = 100 - price (higher price → smaller y).
function makeSeries() {
  const dataChangedHandlers: Array<() => void> = [];
  const attached: unknown[] = [];
  const detached: unknown[] = [];
  const series = {
    attached,
    detached,
    fireDataChanged(): void {
      for (const h of dataChangedHandlers.slice()) h();
    },
    /** The number of LIVE data-changed handlers (0 after a clean teardown). */
    dataChangedCount(): number {
      return dataChangedHandlers.length;
    },
    // --- the public ISeries members the plugin reads -----------------------------
    store: makeStore,
    data: () => BARS,
    dataByIndex: (logical: number, _mismatch: string) => {
      const clamped = Math.max(0, Math.min(BARS.length - 1, Math.round(logical)));
      return BARS[clamped];
    },
    priceToCoordinate: (price: number) => (100 - price) as Coordinate,
    attachPrimitive: (p: unknown): void => {
      attached.push(p);
    },
    detachPrimitive: (p: unknown): void => {
      detached.push(p);
    },
    subscribeDataChanged: (h: () => void) => {
      dataChangedHandlers.push(h);
      return () => {
        const i = dataChangedHandlers.indexOf(h);
        if (i >= 0) dataChangedHandlers.splice(i, 1);
      };
    },
  };
  return series;
}

// A stub time scale: barSpacing 20, rightOffset 0, logical→x is x = logical*20 + 10.
// timeToLogical maps the string time to its numeric value, with §13.14 end clamping for
// nearest modes (a time past the last bar clamps to the last index).
function makeTimeScale(opts?: { barSpacing?: number }) {
  const bs = opts?.barSpacing ?? 20;
  const ts = {
    barSpacing: () => bs,
    rightOffset: () => 0,
    logicalToCoordinate: (logical: number) => (logical * bs + 10) as Coordinate,
    timeToLogical: (time: unknown, mismatch: string) => {
      const n = Number(time);
      if (!Number.isFinite(n)) return null;
      if (mismatch === 'none') {
        return Number.isInteger(n) && n >= 0 && n < BARS.length ? n : null;
      }
      // nearest modes clamp into [0, length-1] (the §13.14 total nearest-search)
      return Math.max(0, Math.min(BARS.length - 1, n));
    },
  };
  return ts;
}

function makeChart(ts: ReturnType<typeof makeTimeScale>) {
  return { timeScale: () => ts };
}

// drive one SceneSource update + return its display lists + a frame for hit-testing.
function frame(hr = 1, vr = 1, bitmapH = 400): ViewFrame {
  return {
    frame: { mediaSize: { width: 400, height: bitmapH }, bitmapSize: { width: 400, height: bitmapH }, hr, vr },
    now: 0,
  } as unknown as ViewFrame;
}

// Extract the single registered SceneSource from a handle's primitive via the recording
// target (the primitive is the object the target received in attachPrimitive).
function sourceOf(series: ReturnType<typeof makeSeries>): SceneSource {
  const prim = series.attached[0] as { sources(): ReadonlyArray<{ source: SceneSource }> };
  return prim.sources()[0].source;
}

function commandsOf(src: SceneSource): DrawCommand[] {
  return src.displayLists().flatMap((l) => l.commands as DrawCommand[]);
}

// the autoscale hook lives on the PRIMITIVE (consulted by the host, design 02 §12.3),
// not on the adapter handle — reach it via the recording attach target.
function primitiveOf(series: ReturnType<typeof makeSeries>): {
  autoscale?: (r: never) => { priceRange: unknown; margins?: { above: number; below: number } } | null;
} {
  return series.attached[0] as never;
}

// the full wiring used by most tests
function setup(markers?: readonly SeriesMarker<string>[], options?: Parameters<typeof createSeriesMarkers>[3]) {
  const series = makeSeries();
  const ts = makeTimeScale();
  const chart = makeChart(ts);
  const handle = createSeriesMarkers(
    chart as never,
    series as never,
    markers as never,
    options,
  );
  return { series, ts, chart, handle };
}

describe('createSeriesMarkers — lifecycle (design 05 §2.2 / §2.7)', () => {
  test('construction attaches ONE primitive to the series (the §2.2 attach)', () => {
    const { series } = setup([]);
    expect(series.attached).toHaveLength(1);
    expect(series.detached).toHaveLength(0);
  });

  test('the registered source sits in band AboveSeries (below crosshair — §2.3/§9.3)', () => {
    const { series } = setup([{ time: '1', position: 'aboveBar', shape: 'circle', color: '#f00', id: 'm1' }]);
    expect(sourceOf(series).zBand).toBe(ZBand.AboveSeries);
  });

  test('detach() is idempotent + total AND tears down the data-changed subscription (§2.7)', () => {
    const { series, handle } = setup([]);
    // a live subscription exists before detach; after the explicit detach it is gone.
    expect(series.dataChangedCount()).toBe(1);
    handle.detach();
    expect(series.detached).toEqual(series.attached); // exactly the same primitive identity
    expect(series.dataChangedCount()).toBe(0); // explicit-detach path tore it down
    handle.detach(); // double-detach — no-op
    handle.detach();
    expect(series.detached).toHaveLength(1);
    // teardown: firing data-changed after detach must NOT touch the (gone) memo path —
    // it is simply unsubscribed, so no handler runs.
    expect(() => series.fireDataChanged()).not.toThrow();
  });

  test('AUTO-detach via primitive.detached() tears down the data-changed handler (no leak — FIX 1)', () => {
    // The host calls primitive.detached() on series/pane removal + chart.dispose (NOT the
    // adapter's explicit detach()). Before FIX 1 this path leaked the subscription.
    const { series } = setup([]);
    const prim = series.attached[0] as { detached(): void };
    expect(series.dataChangedCount()).toBe(1); // the live subscription
    prim.detached(); // the AUTO-detach path
    expect(series.dataChangedCount()).toBe(0); // handler gone — no leak
    // idempotent: a second detached() (or a later explicit detach) must not throw / double-run.
    expect(() => prim.detached()).not.toThrow();
    expect(series.dataChangedCount()).toBe(0);
  });
});

describe('createSeriesMarkers — index resolution (study 08 §4.4 + §13.14 nearest-search)', () => {
  test('a marker time past the last bar attaches to the END bar (§13.14 clamp)', () => {
    // time '9' is past bar 4; nearest-left/right clamp to logical 4 → x = 4*20+10 = 90.
    const { series } = setup([{ time: '9', position: 'inBar', shape: 'circle', color: '#f00', id: 'late' }]);
    const src = sourceOf(series);
    src.update(frame());
    // hit the resolved center: inBar price = close(4)=15 → y = 100-15 = 85; x = 90.
    const hit = src.hitTest!(90 as Coordinate, 85 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.externalId).toBe('late');
  });

  test('a marker time before the first bar snaps RIGHT to bar 0 (§4.4 NearestRight)', () => {
    const { series } = setup([{ time: '-5', position: 'inBar', shape: 'circle', color: '#f00', id: 'early' }]);
    const src = sourceOf(series);
    src.update(frame());
    // bar 0: close=13 → y=87; x = 0*20+10 = 10.
    const hit = src.hitTest!(10 as Coordinate, 87 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.externalId).toBe('early');
  });
});

describe('createSeriesMarkers — emit (study 08 §4.4 shapes + bands)', () => {
  test('each shape kind emits its own command; text emits a media-space text command', () => {
    const { series } = setup([
      { time: '0', position: 'aboveBar', shape: 'circle', color: '#0a0', id: 'c', text: 'hi' },
      { time: '1', position: 'belowBar', shape: 'square', color: '#a00', id: 's' },
      { time: '2', position: 'aboveBar', shape: 'arrowUp', color: '#00a', id: 'a' },
    ]);
    const src = sourceOf(series);
    src.update(frame());
    const kinds = commandsOf(src).map((c) => c.kind);
    expect(kinds).toContain('circles');
    expect(kinds).toContain('rects');
    expect(kinds).toContain('path');
    expect(kinds).toContain('text');
    // the text list is media-space; the glyphs are bitmap-space.
    const spaces = src.displayLists().map((l) => l.space);
    expect(spaces).toContain('bitmap');
    expect(spaces).toContain('media');
  });

  test('an atPriceTop marker WITH a price renders at the resolved center (FIX 2 — typed price)', () => {
    // FIX 2: `price` is now a typed field on SeriesMarker, so atPrice* markers are usable
    // through the typed API (no `as` cast). atPriceTop pins the y to the price's coordinate
    // (no above-stacking offset): price 12 → yc = 100-12 = 88; circle half = 18/2 = 9 (bs=20),
    // so the glyph center is y = 88 - 9 = 79; x = logical 1 * 20 + 10 = 30.
    const { series } = setup([
      { time: '1', position: 'atPriceTop', shape: 'circle', color: '#f00', id: 'ap', price: 12 },
    ]);
    const src = sourceOf(series);
    src.update(frame());
    // it emits a circle command (proves it laid out + drew, not skipped for a missing price).
    expect(commandsOf(src).map((c) => c.kind)).toContain('circles');
    // hit the resolved center: distance 0 inside the glyph, marker id as externalId.
    const hit = src.hitTest!(30 as Coordinate, 79 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.externalId).toBe('ap');
    expect(hit!.distance).toBe(0);
  });

  test('visible:false emits nothing', () => {
    const { series, handle } = setup([{ time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'x' }]);
    handle.applyOptions({ visible: false });
    const src = sourceOf(series);
    src.update(frame());
    expect(commandsOf(src)).toHaveLength(0);
  });
});

describe('createSeriesMarkers — hit testing (design 05 §2.4/§2.7 — real distances, Point priority)', () => {
  test('a hit returns Point priority + the marker id as externalId; distance 0 at the center', () => {
    const { series } = setup([{ time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'mid' }]);
    const src = sourceOf(series);
    src.update(frame());
    // inBar bar 1: close=11 → y=89; x = 1*20+10 = 30.
    const hit = src.hitTest!(30 as Coordinate, 89 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Point);
    expect(hit!.externalId).toBe('mid');
    expect(hit!.distance).toBe(0); // exact center is inside the shape
  });

  test('a far-away point misses (null), proving distance is real, not implicit 0', () => {
    const { series } = setup([{ time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'mid' }]);
    const src = sourceOf(series);
    src.update(frame());
    expect(src.hitTest!(300 as Coordinate, 300 as Coordinate, frame())).toBeNull();
  });

  test('first marker in array order wins among markers (no distance ranking among them)', () => {
    // two markers on the SAME bar/center: the first in array order is returned.
    const { series } = setup([
      { time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'first' },
      { time: '1', position: 'inBar', shape: 'circle', color: '#0f0', id: 'second' },
    ]);
    const src = sourceOf(series);
    src.update(frame());
    const hit = src.hitTest!(30 as Coordinate, 89 as Coordinate, frame());
    expect(hit!.externalId).toBe('first');
  });
});

describe('createSeriesMarkers — autoscale margins (study 08 §4.4 — MAX-merge participation)', () => {
  test('aboveBar markers contribute the full above margin; below is 0', () => {
    const { series } = setup([{ time: '0', position: 'aboveBar', shape: 'circle', color: '#f00', id: 'a' }]);
    const info = primitiveOf(series).autoscale!({ from: 0, to: 4 } as never);
    // ml = shapeHeight(20)*1.5 + shapeMargin(20)*2. base(20,1)=ceiledOdd(20)=19;
    // shapeHeight=ceiledEven(19)=18; shapeMargin=max(base(20,0.1),3)=max(ceiledOdd(2)=1,3)=3.
    // ml = 18*1.5 + 3*2 = 27 + 6 = 33. above=33 (hasAbove), below=0.
    expect(info).not.toBeNull();
    expect(info!.priceRange).toBeNull(); // markers add margins, not range
    expect(info!.margins).toEqual({ above: 33, below: 0 });
  });

  test('inBar-only markers contribute ceil(ml/2) to BOTH sides', () => {
    const { series } = setup([{ time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'i' }]);
    const info = primitiveOf(series).autoscale!({ from: 0, to: 4 } as never);
    expect(info!.margins).toEqual({ above: Math.ceil(33 / 2), below: Math.ceil(33 / 2) }); // {17,17}
  });

  test('autoScale:false OR no markers → no contribution (null)', () => {
    const { series } = setup([], undefined);
    expect(primitiveOf(series).autoscale!({ from: 0, to: 4 } as never)).toBeNull(); // no markers
    const { series: s2 } = setup([{ time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'i' }], {
      autoScale: false,
    });
    expect(primitiveOf(s2).autoscale!({ from: 0, to: 4 } as never)).toBeNull();
  });
});

describe('createSeriesMarkers — validation (design 05 §2.7 item 1)', () => {
  test("setMarkers rejects unsorted input under default 'throw' validation", () => {
    const { handle } = setup([]);
    expect(() =>
      handle.setMarkers([
        { time: '3', position: 'inBar', shape: 'circle', color: '#f00', id: 'b' },
        { time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'a' },
      ]),
    ).toThrow(/ascending/);
  });

  test("validation:'skip' drops the out-of-order marker instead of throwing", () => {
    const { handle } = setup([], { validation: 'skip' });
    handle.setMarkers([
      { time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'a' },
      { time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'dropped' },
      { time: '2', position: 'inBar', shape: 'circle', color: '#f00', id: 'c' },
    ]);
    expect(handle.markers().map((m) => m.id)).toEqual(['a', 'c']);
  });

  test('an atPrice* marker without a price throws (study 08 §4.4)', () => {
    const { handle } = setup([]);
    expect(() =>
      handle.setMarkers([{ time: '1', position: 'atPriceTop', shape: 'circle', color: '#f00', id: 'p' }]),
    ).toThrow(/price/);
  });
});

describe('createSeriesMarkers — options + setMarkers/markers (design 02 §12.4 adapter)', () => {
  test('defaults match the kept reference defaults', () => {
    expect(defaultSeriesMarkersOptions.visible).toBe(true);
    expect(defaultSeriesMarkersOptions.validation).toBe('throw');
    expect(defaultSeriesMarkersOptions.autoScale).toBe(true);
  });

  test('markers() returns the current set; setMarkers replaces it', () => {
    const { handle } = setup([{ time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'a' }]);
    expect(handle.markers().map((m) => m.id)).toEqual(['a']);
    handle.setMarkers([{ time: '2', position: 'inBar', shape: 'square', color: '#0f0', id: 'b' }]);
    expect(handle.markers().map((m) => m.id)).toEqual(['b']);
  });

  test('a data-changed event invalidates the resolved-index memo (re-resolves next frame)', () => {
    const { series } = setup([{ time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'm' }]);
    const src = sourceOf(series);
    src.update(frame());
    expect(src.hitTest!(30 as Coordinate, 89 as Coordinate, frame())).not.toBeNull();
    // fire data-changed: memo cleared; a fresh update re-resolves without error.
    series.fireDataChanged();
    const f2 = frame();
    // bump signature so update rebuilds (different bitmapH → new sig)
    src.update(frame(1, 1, 401));
    expect(() => src.hitTest!(30 as Coordinate, 89 as Coordinate, f2)).not.toThrow();
  });
});
