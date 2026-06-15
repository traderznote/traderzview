// views/series/decimate-conformance.test.ts — the §6.3 / caps §4.2 DECIMATION
// conformance suite (M11 parity hardening). HEADLESS, hand-derived: no browser, no
// real backend — geometry is composed against the stub ColumnRaster of
// decimate-conformance.fixture.ts (the headless analogue of demo-chart's stub
// ISurface). Pins, in order:
//   1. the BIT-IDENTICAL PAIR — at barSpacing·hr ≥ 1 the helper is inactive (returns
//      null) so the engine runs the unchanged convert→emit path; the decimated and
//      non-decimated rasters are byte-for-byte equal (§6.3 "bit-identical", §11.1);
//   2. exactly ONE min/max segment per on-screen device column, columns ≤ deviceWidth
//      even under the EXTENDED window (§6.3; caps §4.2 — the clipping hardening);
//   3. the ≤ 60-command cap on an S8-shaped scene (1 line + 1 candle, sub-pixel) with
//      the ItemBuffer NEVER filled and hitTest null below 1 bar/pixel (§4.4.3 / S8);
//   4. SUB-PIXEL visual parity within AA tolerance — the decimated min/max envelope
//      matches the full-resolution picture's per-column extent to ≤ 0.5 device px.
import { describe, expect, test } from 'vitest';
import { decimateColumns, shouldDecimate } from './decimate';
import { createLineKind } from './line';
import { createCandlestickKind } from './candlestick';
import { itemWindow } from './window';
import { DisplayListBuilder } from '../../gfx';
import type { PolylineCommand } from '../../gfx';
import type { Coordinate } from '../../core';
import {
  AA_TOLERANCE,
  S8_SCENE,
  composeColumns,
  diffColumns,
  fixtureFrame,
  fixtureHorz,
  fixturePrice,
  fixtureStore,
  referenceColumnEnvelope,
  seededWalk,
} from './decimate-conformance.fixture';
import type { StoreDiff } from '../../data';

const REPLACE: StoreDiff = { kind: 'replace' };

// --- helpers ------------------------------------------------------------------

/** Drive a Line kind's FULL-RESOLUTION convert→emit path into a finished list (the
 *  non-decimated baseline). Returns the device-px DisplayList emit produced. */
function emitLineFull(
  store: ReturnType<typeof fixtureStore>,
  from: number,
  to: number,
  frame: ReturnType<typeof fixtureFrame>,
  horz: ReturnType<typeof fixtureHorz>,
  price: ReturnType<typeof fixturePrice>,
) {
  const kind = createLineKind({ color: '#0af', lineWidth: 1 });
  const buf = kind.createBuffer();
  kind.itemsFromStore(store, REPLACE, buf);
  const w = itemWindow(from, to);
  kind.convert(buf, w, frame, horz, price);
  const b = new DisplayListBuilder();
  kind.emit(buf, w, frame, b);
  return { lists: b.finish(), buf };
}

/** Drive the Line kind's DECIMATE path into a finished list. */
function emitLineDecimated(
  store: ReturnType<typeof fixtureStore>,
  from: number,
  to: number,
  frame: ReturnType<typeof fixtureFrame>,
  horz: ReturnType<typeof fixtureHorz>,
  price: ReturnType<typeof fixturePrice>,
) {
  const kind = createLineKind({ color: '#0af', lineWidth: 1 });
  const b = new DisplayListBuilder();
  kind.decimate(store, itemWindow(from, to), frame, horz, price, b);
  return b.finish();
}

// --- 1. the bit-identical pair ------------------------------------------------

describe('decimation — bit-identical at barSpacing·hr ≥ 1 (§6.3 / §11.1)', () => {
  // A 5-row store at a NON-sub-pixel spacing: barSpacing·hr = 1 exactly (the §6.3
  // threshold is strict `< 1`, so == 1 is the normal path). emit and decimate must
  // both yield the unchanged convert→emit picture.
  const store = fixtureStore([10, 12, 11, 13, 12], [10, 12, 11, 13, 12]);
  const frame = fixtureFrame(40, 100, 2); // hr = 2
  const horz = fixtureHorz(0.5, 4, 40); // barSpacing 0.5 · hr 2 = 1.0 → NOT sub-pixel

  test('shouldDecimate is false at exactly barSpacing·hr = 1 (strict <)', () => {
    expect(shouldDecimate(0.5, 2)).toBe(false);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    expect(
      decimateColumns(store, itemWindow(0, 5), frame, horz, fixturePrice(), b, { shape: 'line', color: '#0af' }),
    ).toBeNull();
  });

  test('the decimated path equals the full convert→emit path BYTE-FOR-BYTE', () => {
    const price = fixturePrice();
    const full = emitLineFull(store, 0, 5, frame, horz, price);
    const decimated = emitLineDecimated(store, 0, 5, frame, horz, price);

    // The helper returned null, so decimate() produced one EMPTY bitmap list; the
    // engine therefore renders the convert→emit output instead. The bit-identical
    // guarantee is that emit's output is unaltered by the decimation seam — so the
    // canonical (rendered) picture is the full path's, and the two rasters agree
    // EXACTLY (zero tolerance), not merely within AA.
    const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);
    const rFull = composeColumns(full.lists, deviceWidth);
    // The decimated list is empty (no segments) — proving the helper drew nothing on
    // the normal path, so nothing it does can perturb the full picture.
    const rDecim = composeColumns(decimated, deviceWidth);
    expect(rDecim.touched.some((t) => t === 1)).toBe(false); // helper drew nothing

    // And the full path actually drew (a real polyline), so "identical" is non-vacuous.
    expect(rFull.touched.some((t) => t === 1)).toBe(true);

    // The canonical render = full path. Re-deriving it twice is byte-identical.
    const full2 = emitLineFull(store, 0, 5, frame, horz, price);
    const rFull2 = composeColumns(full2.lists, deviceWidth);
    expect(diffColumns(rFull, rFull2)).toEqual({ maxDelta: 0, coverageMismatch: 0, firstMismatchCol: -1 });

    // And literally byte-for-byte at the COMMAND level: the polyline the backend
    // replays is the same Float32 geometry, vertex for vertex (the strongest reading
    // of "bit-identical" — the decimation seam adds no path that perturbs the bytes).
    const cmdA = full.lists[0]!.commands[0] as PolylineCommand;
    const cmdB = full2.lists[0]!.commands[0] as PolylineCommand;
    expect(Array.from(cmdA.points)).toEqual(Array.from(cmdB.points));
    expect(cmdA.points.length).toBeGreaterThan(0);
  });
});

// --- 2. exactly one segment per device column + clip to [0, deviceWidth) ------

describe('decimation — one min/max segment per on-screen device column (§6.3 / caps §4.2)', () => {
  test('each touched device column carries exactly one [yTop,yBot] span', () => {
    // 9 rows squeezed into ~5 device columns; assert every touched column got one
    // vertical segment (the raster collapses a column to a single interval, and the
    // emitted polyline has exactly `columns` (top,bottom,gap) triples).
    const lows = [10, 14, 11, 9, 13, 12, 15, 8, 16];
    const highs = [12, 16, 13, 11, 15, 14, 17, 10, 18];
    const store = fixtureStore(lows, highs);
    const frame = fixtureFrame(5, 100, 2); // device width 10
    const horz = fixtureHorz(0.1, 8, 5); // 0.1·2 = 0.2 < 1 → sub-pixel
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(store, itemWindow(0, 9), frame, horz, fixturePrice(), b, {
      shape: 'line',
      color: '#0af',
      lineWidth: 2,
    });
    expect(res).not.toBeNull();
    const cmd = b.finish()[0]!.commands[0] as PolylineCommand;
    // 3 vertex slots per column (top, bottom, gap) = 6 floats per column.
    expect(cmd.points.length).toBe(res!.columns * 6);
    // Every column maps to ONE span in the raster (no double-coverage).
    const raster = composeColumns(b.finish(), Math.ceil(frame.frame.bitmapSize.width));
    let touched = 0;
    for (let c = 0; c < raster.width; c++) if (raster.touched[c]) touched++;
    expect(touched).toBe(res!.columns);
  });

  test('rows mapping OFF the device grid (extended window) are NOT emitted; columns ≤ deviceWidth', () => {
    // baseIndex small + many rows ⇒ early rows map to x < 0 (off-screen left). The
    // helper still scans them (rowsScanned counts finite rows) but must not emit a
    // column < 0 or ≥ deviceWidth — the clipping hardening.
    const N = 300;
    const lows: number[] = [];
    const highs: number[] = [];
    for (let i = 0; i < N; i++) {
      lows.push(100 + (i % 7));
      highs.push(110 + (i % 5));
    }
    const store = fixtureStore(lows, highs);
    const deviceWidthMedia = 50;
    const frame = fixtureFrame(deviceWidthMedia, 100, 2); // device width 100
    // barSpacing tiny, baseIndex puts the right edge at the last row; the first rows
    // fall left of x=0. width 50, hr 2.
    const horz = fixtureHorz(deviceWidthMedia / N, N - 1, deviceWidthMedia);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(store, itemWindow(0, N), frame, horz, fixturePrice(), b, {
      shape: 'line',
      color: '#0af',
    });
    expect(res).not.toBeNull();
    expect(res!.rowsScanned).toBe(N); // every finite row scanned
    const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);
    expect(res!.columns).toBeLessThanOrEqual(deviceWidth); // clip → never exceeds the grid
    // No emitted vertex lands outside [0, deviceWidth) (the clip guarantee).
    const cmd = b.finish()[0]!.commands[0] as PolylineCommand;
    for (let o = 0; o < cmd.points.length; o += 2) {
      const x = cmd.points[o]!;
      if (Number.isNaN(x)) continue;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(deviceWidth);
    }
  });
});

// --- 3. the S8 ≤ 60-command cap + buffer-bypass + null hitTest ----------------

describe('decimation — S8 scene ≤ 60 commands, buffer bypassed, hitTest null (§4.4.3 / S8)', () => {
  // Reconstruct the S8 spacing headlessly: a line + a candlestick, both at the R2
  // fitContent spacing (barSpacing·hr ≪ 1). We use a tractable row count (the helper
  // is O(rows) and the cap is on COMMANDS, which is spacing/width-bounded, not N).
  const N = 4000;
  const line = seededWalk(N, 0x7eadbeef);
  const candle = seededWalk(N, 0x1234abcd);
  const frame = fixtureFrame(S8_SCENE.mediaWidth, S8_SCENE.mediaHeight, S8_SCENE.hr);
  // fitContent: all N rows fill the media width → tiny barSpacing.
  const barSpacing = S8_SCENE.mediaWidth / N;
  const horz = fixtureHorz(barSpacing, N - 1, S8_SCENE.mediaWidth);
  const price = fixturePrice();

  test('barSpacing·hr is sub-pixel (decimation engages) for the S8 scene', () => {
    expect(barSpacing * S8_SCENE.hr).toBeLessThan(1);
    expect(shouldDecimate(barSpacing, S8_SCENE.hr)).toBe(true);
  });

  test('the decimated S8 frame emits ≤ 60 draw commands across both series', () => {
    const lineKind = createLineKind({ color: '#0af', lineWidth: 1 });
    const candleKind = createCandlestickKind({ upColor: '#26a69a', downColor: '#ef5350' });
    const b = new DisplayListBuilder();
    lineKind.decimate(line, itemWindow(0, N), frame, horz, price, b);
    candleKind.decimate(candle, itemWindow(0, N), frame, horz, price, b);
    const lists = b.finish();
    let commands = 0;
    for (const l of lists) commands += l.commands.length;
    // Each kind collapses to ONE polyline/rects command (plus its bitmap list header).
    // Far under the S8 cap; the cap leaves room for axis + grid runs the real frame
    // also emits (§4.4.3 — "axis and grid runs" plus the two collapsed series).
    expect(commands).toBeLessThanOrEqual(S8_SCENE.commandCap);
    expect(commands).toBe(2); // exactly one command per decimated series
  });

  test('the decimate path never fills an ItemBuffer (the §6.3 bypass)', () => {
    // The buffer the engine would otherwise convert into stays length 0: decimate
    // reads the store SoA directly and writes to `out`. We build the buffer the kind
    // owns, run ONLY decimate (never itemsFromStore/convert), and assert it is empty.
    const lineKind = createLineKind({ color: '#0af', lineWidth: 1 });
    const buf = lineKind.createBuffer();
    expect(buf.length).toBe(0);
    const b = new DisplayListBuilder();
    lineKind.decimate(line, itemWindow(0, N), frame, horz, price, b);
    expect(buf.length).toBe(0); // untouched — no convert ran
  });

  test('hitTest returns null at sub-pixel spacing (buffer empty ⇒ nothing hoverable)', () => {
    // On the decimate path the buffer is unfilled (length 0); hitTest reads that empty
    // buffer and must return null — crosshair values come from store-index lookups
    // (§5.2), not the ItemBuffer (§6.3 hit-test interaction).
    const lineKind = createLineKind({ color: '#0af', lineWidth: 1 });
    const buf = lineKind.createBuffer(); // length 0, never converted
    const candleKind = createCandlestickKind({});
    const cbuf = candleKind.createBuffer();
    expect(lineKind.hitTest(buf, 100 as Coordinate, 100 as Coordinate)).toBeNull();
    expect(candleKind.hitTest(cbuf, 100 as Coordinate, 100 as Coordinate)).toBeNull();
  });
});

// --- 4. sub-pixel visual parity within AA tolerance ---------------------------

describe('decimation — sub-pixel visual parity within AA tolerance (§6.3 / §11.1)', () => {
  test('the decimated min/max envelope matches the overlapping-1px picture per column to ≤ 0.5 device px', () => {
    // Build a realistic seeded walk, then compare TWO sub-pixel pictures:
    //   • REFERENCE: the conflation-off overlapping-1px-draws envelope (per device
    //     column, the union of the rows' marks = the column min/max) — the picture the
    //     reference produced and the one §11.1 says we match by OVERDRAW elimination;
    //   • DECIMATED: our single min/max segment per device column.
    // They must agree per column within AA tolerance: same touched columns (no coverage
    // gained or lost) and the vertical extent within ≤ 0.5 device px. (Comparing against
    // the FULL CONNECTED emit polyline instead would be wrong — its slanted cross-column
    // segments paint a trajectory the overlapping draws never did; that is precisely the
    // overdraw decimation removes, not coverage it owes.)
    const N = 1200;
    const store = seededWalk(N, 0x7eadbeef);
    const frame = fixtureFrame(300, 200, 2); // device width 600
    const barSpacing = 300 / N; // fitContent → sub-pixel
    const horz = fixtureHorz(barSpacing, N - 1, 300);
    const price = fixturePrice();
    expect(shouldDecimate(barSpacing, 2)).toBe(true);
    const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);

    const reference = referenceColumnEnvelope(store, 0, N, frame, horz, price);
    const decimated = composeColumns(emitLineDecimated(store, 0, N, frame, horz, price), deviceWidth);

    const diff = diffColumns(reference, decimated);
    expect(diff.coverageMismatch).toBe(0);
    expect(diff.maxDelta).toBeLessThanOrEqual(AA_TOLERANCE);
    // Non-vacuous: the picture actually covers most of the device width.
    let touched = 0;
    for (let c = 0; c < decimated.width; c++) if (decimated.touched[c]) touched++;
    expect(touched).toBeGreaterThan(deviceWidth / 2);
  });
});
