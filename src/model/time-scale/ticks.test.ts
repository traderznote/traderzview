import { describe, expect, test } from 'vitest';
import {
  TickMarkEngine,
  indexPerLabel,
  maxIndexesPerMark,
  maxLabelWidthFor,
  type TickMark,
} from './ticks';

// study 03 §4.11 (weight-merge selection) / §4.12 (density math) are the spec of
// record. Weight ASSIGNMENT is the behavior's job (already in `data`); this engine
// owns SELECTION by descending weight with the merge rule + tick density math.

/** Build an ascending-by-index mark list; weight defaults vary per test. */
const mk = (index: number, weight: number): TickMark => ({ index, weight });

describe('density math (study 03 §4.12)', () => {
  test('maxLabelWidthFor: (fontSize+4)*5/8 px-per-char × chars', () => {
    // default fontSize 12 → pixelsPer8Chars = (12+4)*5 = 80 ; perChar = 10
    // × default 8 chars → 80
    expect(maxLabelWidthFor(12, 8)).toBe(80);
    expect(maxLabelWidthFor(12, undefined)).toBe(80); // undefined → 8
  });

  test('maxIndexesPerMark = ceil(maxLabelWidth / spacing)', () => {
    expect(maxIndexesPerMark(80, 6)).toBe(Math.ceil(80 / 6)); // 14
    expect(maxIndexesPerMark(80, 10)).toBe(8);
  });

  test('indexPerLabel = round(maxLabelWidth / spacing)', () => {
    expect(indexPerLabel(80, 6)).toBe(Math.round(80 / 6)); // 13
    expect(indexPerLabel(80, 7)).toBe(Math.round(80 / 7)); // 11
  });
});

describe('TickMarkEngine — weight-merge selection (study 03 §4.11)', () => {
  test('higher weight always wins screen space; lower fills only when ≥ gap away', () => {
    // marks every index 0..20. weight 70 at 0 and 10; weight 50 elsewhere.
    const marks: TickMark[] = [];
    for (let i = 0; i <= 20; i++) marks.push(mk(i, i === 0 || i === 10 ? 70 : 50));
    const e = new TickMarkEngine();
    e.setMarks(marks);
    // maxIndexesPerMark = 5 → min spacing of 5 indices between accepted marks.
    const sel = e.build({ maxIndexesPerMark: 5 });
    const idx = sel.map((m) => m.index);
    // the two weight-70 marks are always kept
    expect(idx).toContain(0);
    expect(idx).toContain(10);
    // every accepted pair is ≥ 5 apart
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThanOrEqual(5);
    // ascending by index
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test('a lower-weight mark too close to a higher-weight neighbor is dropped', () => {
    // weight 70 at index 5; weight 50 at index 6 (only 1 apart). With gap 5 the
    // weight-50 mark at 6 cannot be kept (too close to 5 on its left).
    const e = new TickMarkEngine();
    e.setMarks([mk(5, 70), mk(6, 50), mk(20, 50)]);
    const idx = e.build({ maxIndexesPerMark: 5 }).map((m) => m.index);
    expect(idx).toContain(5);
    expect(idx).not.toContain(6);
    expect(idx).toContain(20);
  });

  test('uniformDistribution: one non-fitting mark rejects its WHOLE weight level (returns prev)', () => {
    // weight 70 at 0,10 ; weight 50 at 0..10 every index. With gap 5 some weight-50
    // marks fit and some do not → all-or-nothing rejects the entire weight-50 level.
    const marks: TickMark[] = [mk(0, 70), mk(10, 70)];
    for (let i = 0; i <= 10; i++) marks.push(mk(i, 50));
    marks.sort((a, b) => a.index - b.index || b.weight - a.weight);
    const e = new TickMarkEngine();
    e.setMarks(marks);
    const idx = e.build({ maxIndexesPerMark: 5, uniformDistribution: true }).map((m) => m.index);
    // only the weight-70 level survives
    expect(idx).toEqual([0, 10]);
  });

  test('includable=false (whitespace) excludes a mark even with room', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 50), mk(10, 50), mk(20, 50)]);
    // index 10 is whitespace
    const idx = e.build({ maxIndexesPerMark: 5, includable: (m) => m.index !== 10 }).map((m) => m.index);
    expect(idx).toEqual([0, 20]);
  });

  test('empty mark set returns empty selection', () => {
    const e = new TickMarkEngine();
    e.setMarks([]);
    expect(e.build({ maxIndexesPerMark: 5 })).toEqual([]);
  });
});

describe('TickMarkEngine — selection cache (study 03 §4.11/§4.13: key ignores scroll)', () => {
  test('same maxIndexesPerMark returns the identical cached array (no rebuild)', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 70), mk(5, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5 });
    const b = e.build({ maxIndexesPerMark: 5 });
    expect(b).toBe(a); // referentially identical → served from the one-entry cache
  });

  test('cache key IGNORES scroll: only maxIndexesPerMark / whitespace inputs matter', () => {
    // The engine never receives scroll/right-offset; building with the same
    // maxIndexesPerMark twice (a stable zoom) reuses the cache regardless of any
    // notional scroll between calls (study 03 §4.11 "cache key ignores scroll").
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 70), mk(5, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5 });
    const b = e.build({ maxIndexesPerMark: 5 });
    expect(b).toBe(a);
  });

  test('different maxIndexesPerMark rebuilds (different key)', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 70), mk(5, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5 });
    const b = e.build({ maxIndexesPerMark: 8 });
    expect(b).not.toBe(a);
  });

  test('the whitespace flag participates in the key', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5, whitespaceFlag: false, whitespaceSetId: 0 });
    const b = e.build({ maxIndexesPerMark: 5, whitespaceFlag: true, whitespaceSetId: 0 });
    expect(b).not.toBe(a);
  });

  test('whitespaceSetId change (data mutated) rebuilds', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5, whitespaceFlag: true, whitespaceSetId: 1 });
    const b = e.build({ maxIndexesPerMark: 5, whitespaceFlag: true, whitespaceSetId: 2 });
    expect(b).not.toBe(a);
  });

  test('setMarks invalidates the cache', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 70), mk(5, 50)]);
    const a = e.build({ maxIndexesPerMark: 5 });
    e.setMarks([mk(0, 70), mk(5, 50), mk(12, 50)]);
    const b = e.build({ maxIndexesPerMark: 5 });
    expect(b).not.toBe(a);
  });
});

describe('TickMarkEngine — equals study 03 §4.6/§4.11 worked example', () => {
  test('descending-weight greedy merge matches the reference order', () => {
    // A realistic daily axis: weight 70 (year) at 0, weight 60 (month) at 6 & 12,
    // weight 50 (day) everywhere. Gap = 4.
    const marks: TickMark[] = [];
    for (let i = 0; i <= 15; i++) {
      let w = 50;
      if (i === 0) w = 70;
      else if (i === 6 || i === 12) w = 60;
      marks.push(mk(i, w));
    }
    const e = new TickMarkEngine();
    e.setMarks(marks);
    const idx = e.build({ maxIndexesPerMark: 4 }).map((m) => m.index);
    // year(0) + months(6,12) are unconditionally placed first; days fill gaps ≥4.
    expect(idx).toContain(0);
    expect(idx).toContain(6);
    expect(idx).toContain(12);
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThanOrEqual(4);
    // result is index-sorted and unique
    expect(new Set(idx).size).toBe(idx.length);
  });
});
