import { describe, expect, test } from 'vitest';
import { hitTestPane, toHoverTarget } from './hit-test';
import type { HitSource } from './hit-test';
import { HitPriority, ZBand } from '../gfx';
import type { HitCandidate, SceneSource, ViewFrame } from '../gfx';
import type { Coordinate } from '../core';

// --- fakes --------------------------------------------------------------------

const FRAME: ViewFrame = {
  frame: { mediaSize: { width: 300, height: 200 }, bitmapSize: { width: 300, height: 200 }, hr: 1, vr: 1 },
  now: 0,
};

/** A source that returns a fixed candidate (or null) regardless of the query — the
 *  arbitration math under test is purely over the (priority, distance, paint-order)
 *  triple, so the fakes hand those numbers in directly. */
function src(zBand: ZBand, cand: HitCandidate | null): SceneSource {
  return {
    zBand,
    update() {},
    displayLists: () => [],
    hitTest: () => cand,
  };
}

/** A source that records whether it was queried (to assert single-pass behavior). */
function countingSrc(cand: HitCandidate | null) {
  let calls = 0;
  const source: SceneSource = {
    zBand: ZBand.Series,
    update() {},
    displayLists: () => [],
    hitTest: () => {
      calls++;
      return cand;
    },
  };
  return { source, calls: () => calls };
}

function hitSource(sourceId: string, source: SceneSource, seriesId?: string): HitSource {
  return seriesId === undefined ? { sourceId, source } : { sourceId, source, seriesId };
}

const X = 50 as Coordinate;
const Y = 50 as Coordinate;

// --- priority tier: Point beats non-Point (design 05 §2.4) --------------------

describe('hitTestPane — tier: Point beats non-Point', () => {
  test('a Point candidate at distance 5 still beats a Line candidate at distance 1', () => {
    // tier is consulted FIRST: Point (tier 1) > Line (tier 0), so distance is moot.
    const point = hitSource('p', src(ZBand.Series, { distance: 5, priority: HitPriority.Point }));
    const line = hitSource('l', src(ZBand.Series, { distance: 1, priority: HitPriority.Line }));
    const { ranked } = hitTestPane([line, point], X, Y, FRAME);
    expect(ranked.map((r) => r.sourceId)).toEqual(['p', 'l']);
    expect(ranked[0]!.candidate.priority).toBe(HitPriority.Point);
  });

  test('Line vs Range do NOT differ on tier — nearer distance wins (Range at 1 beats Line at 4)', () => {
    // §2.4: "Line vs Range fall through to distance". A Range at distance 1 outranks
    // a Line at distance 4 — there is NO Line-over-Range tier.
    const line = hitSource('l', src(ZBand.Series, { distance: 4, priority: HitPriority.Line }));
    const range = hitSource('r', src(ZBand.Series, { distance: 1, priority: HitPriority.Range }));
    const { ranked } = hitTestPane([line, range], X, Y, FRAME);
    expect(ranked.map((r) => r.sourceId)).toEqual(['r', 'l']);
  });
});

// --- distance precedes paint order (the §2.4 worked example) ------------------

describe('hitTestPane — distance beats paint order (worked example)', () => {
  test('a Series body at distance 0 beats a primitive Line at distance 3 in a HIGHER band', () => {
    // The §2.4 worked example verbatim: body (band Series, dist 0) vs primitive line
    // (band AboveSeries, dist 3). Both are non-Point (tier 0), so tier ties; distance
    // 0 < 3 decides BEFORE paint order is ever consulted — the higher band does NOT win.
    const body = hitSource('body', src(ZBand.Series, { distance: 0, priority: HitPriority.Line }));
    const prim = hitSource('prim', src(ZBand.AboveSeries, { distance: 3, priority: HitPriority.Line }));
    // paint order: body listed first (lower), prim later (visually higher).
    const { ranked, target } = hitTestPane([body, prim], X, Y, FRAME);
    expect(ranked[0]!.sourceId).toBe('body'); // distance wins
    expect(target!.sourceId).toBe('body');
  });
});

// --- paint order is the FINAL tie-break only ----------------------------------

describe('hitTestPane — paint order: only an exact (tier,distance) tie', () => {
  test('equal tier + equal distance → the LATER (visually higher) source wins', () => {
    // Two identical Line candidates at distance 2; the one painted later (higher in
    // the §2.3 (band, ownerZ, attachSeq) order, here = later array index) wins.
    const lower = hitSource('lower', src(ZBand.Series, { distance: 2, priority: HitPriority.Line }));
    const higher = hitSource('higher', src(ZBand.AboveSeries, { distance: 2, priority: HitPriority.Line }));
    const { ranked } = hitTestPane([lower, higher], X, Y, FRAME);
    expect(ranked.map((r) => r.sourceId)).toEqual(['higher', 'lower']);
  });

  test('the tie-break is by ARRAY position, independent of how they were passed', () => {
    // Same candidates, passed higher-first: array index still encodes paint order, so
    // the element at the larger index ('b') wins the exact tie.
    const a = hitSource('a', src(ZBand.Series, { distance: 2, priority: HitPriority.Line }));
    const b = hitSource('b', src(ZBand.Series, { distance: 2, priority: HitPriority.Line }));
    const { ranked } = hitTestPane([a, b], X, Y, FRAME);
    expect(ranked[0]!.sourceId).toBe('b'); // b is later in paint order → on top
  });
});

// --- collection / single pass / misses ----------------------------------------

describe('hitTestPane — collection', () => {
  test('sources returning null or lacking hitTest are skipped; nothing hit → empty + null target', () => {
    const miss = hitSource('miss', src(ZBand.Series, null));
    const noHit: SceneSource = { zBand: ZBand.Grid, update() {}, displayLists: () => [] }; // no hitTest
    const res = hitTestPane([miss, hitSource('nh', noHit)], X, Y, FRAME);
    expect(res.ranked).toEqual([]);
    expect(res.target).toBeNull();
  });

  test('each source is queried exactly once (single flat pass)', () => {
    const a = countingSrc({ distance: 1, priority: HitPriority.Line });
    const b = countingSrc(null);
    hitTestPane([hitSource('a', a.source), hitSource('b', b.source)], X, Y, FRAME);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });

  test('the pointer coordinates and frame are forwarded to source.hitTest', () => {
    let seen: { x: number; y: number; w: number } | null = null;
    const probe: SceneSource = {
      zBand: ZBand.Series,
      update() {},
      displayLists: () => [],
      hitTest: (x, y, f) => {
        seen = { x: x as number, y: y as number, w: f.frame.mediaSize.width };
        return null;
      },
    };
    hitTestPane([hitSource('p', probe)], 7 as Coordinate, 9 as Coordinate, FRAME);
    expect(seen).toEqual({ x: 7, y: 9, w: 300 });
  });
});

// --- HoverTarget mapping (architecture §5.5) ----------------------------------

describe('hitTestPane — HoverTarget of the winner (index 0)', () => {
  test('copies sourceId/seriesId from the source and externalId/cursor/data from the candidate', () => {
    const winner = hitSource(
      'series-1',
      src(ZBand.Series, {
        distance: 0,
        priority: HitPriority.Point,
        externalId: 'order-42',
        cursor: 'pointer',
        data: { kind: 'marker' },
      }),
      'series-1',
    );
    const { target } = hitTestPane([winner], X, Y, FRAME);
    expect(target).toEqual({
      sourceId: 'series-1',
      seriesId: 'series-1',
      externalId: 'order-42',
      cursor: 'pointer',
      data: { kind: 'marker' },
    });
  });

  test('omits optional fields the candidate did not supply (no undefined keys)', () => {
    const winner = hitSource('s', src(ZBand.Series, { distance: 0, priority: HitPriority.Line }));
    const { target } = hitTestPane([winner], X, Y, FRAME);
    expect(target).toEqual({ sourceId: 's' });
    expect('seriesId' in target!).toBe(false);
    expect('cursor' in target!).toBe(false);
    expect('data' in target!).toBe(false);
  });

  test('the HoverTarget always describes ranked[0]', () => {
    const point = hitSource('p', src(ZBand.Series, { distance: 9, priority: HitPriority.Point }), 'series-p');
    const line = hitSource('l', src(ZBand.AboveSeries, { distance: 0, priority: HitPriority.Line }));
    const { ranked, target } = hitTestPane([line, point], X, Y, FRAME);
    // Point tier wins despite distance 9; target mirrors the winner.
    expect(ranked[0]!.sourceId).toBe('p');
    expect(target!.sourceId).toBe('p');
    expect(target!.seriesId).toBe('series-p');
  });

  test('toHoverTarget is a pure mapping over a RankedHit', () => {
    const t = toHoverTarget({
      candidate: { distance: 0, priority: HitPriority.Point, cursor: 'grab' },
      sourceId: 'x',
      seriesId: 'y',
    });
    expect(t).toEqual({ sourceId: 'x', seriesId: 'y', cursor: 'grab' });
  });
});

// --- full ranked ordering -----------------------------------------------------

describe('hitTestPane — full ranked list (study 07: tools consume the list)', () => {
  test('three hits rank Point-first, then by distance, then paint order', () => {
    const line2 = hitSource('line2', src(ZBand.Series, { distance: 2, priority: HitPriority.Line }));
    const line1 = hitSource('line1', src(ZBand.AboveSeries, { distance: 1, priority: HitPriority.Line }));
    const point = hitSource('point', src(ZBand.Series, { distance: 8, priority: HitPriority.Point }));
    // paint order as passed: line2 (lowest), line1, point (highest).
    const { ranked } = hitTestPane([line2, line1, point], X, Y, FRAME);
    // point (tier) first; then line1 (dist 1) before line2 (dist 2).
    expect(ranked.map((r) => r.sourceId)).toEqual(['point', 'line1', 'line2']);
    expect(ranked.map((r) => r.candidate.distance)).toEqual([8, 1, 2]);
  });
});
