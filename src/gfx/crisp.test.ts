import { describe, expect, test } from 'vitest';
import {
  applyBarParity,
  ceiledEven,
  ceiledOdd,
  crispRound,
  crispStrokePos,
  crispWidth,
  edgeToRect,
  evenCeil,
  evenFloor,
  optimalBarWidth,
  optimalCandlestickWidth,
  tickRect,
} from './crisp';

describe('crispWidth — max(1, floor(mediaWidth · ratio)); never 0, never fractional', () => {
  test('values', () => {
    expect(crispWidth(1, 1)).toBe(1);
    expect(crispWidth(1, 2)).toBe(2);
    expect(crispWidth(1, 1.5)).toBe(1);
    expect(crispWidth(2, 1.5)).toBe(3);
    expect(crispWidth(0.5, 1)).toBe(1); // clamped up from 0
    expect(crispWidth(3, 2)).toBe(6);
  });
});

describe('crispRound — round(coord · ratio)', () => {
  test('values', () => {
    expect(crispRound(10, 2)).toBe(20);
    expect(crispRound(10.3, 1)).toBe(10);
    expect(crispRound(10.5, 1)).toBe(11);
  });
});

describe('crispStrokePos — round(coord·ratio) + half-pixel shift when line width is odd', () => {
  test('odd width shifts +0.5; even width does not', () => {
    expect(crispStrokePos(10, 1, 1)).toBe(10.5);
    expect(crispStrokePos(10, 1, 2)).toBe(10);
    expect(crispStrokePos(10, 2, 1)).toBe(20.5);
    expect(crispStrokePos(10.5, 1, 3)).toBe(11.5);
    expect(crispStrokePos(10.5, 1, 4)).toBe(11);
  });
});

describe('tickRect — filled-rect line substitute (study 05 §4.4)', () => {
  test('pos recentres by floor(ratio·0.5); thickness = max(1, floor(ratio))', () => {
    expect(tickRect(10, 1, 5)).toEqual({ pos: 10, thickness: 1, length: 5 });
    expect(tickRect(10, 2, 5)).toEqual({ pos: 19, thickness: 2, length: 5 });
    expect(tickRect(10, 3, 8)).toEqual({ pos: 29, thickness: 3, length: 8 });
  });
});

describe('edgeToRect — inclusive-edge convention w = right − left + 1', () => {
  test('values', () => {
    expect(edgeToRect(3, 7)).toEqual({ x: 3, w: 5 });
    expect(edgeToRect(10, 10)).toEqual({ x: 10, w: 1 });
  });
});

describe('optimalBarWidth — floor(barSpacing · 0.3 · pr) (study 06 §4.8)', () => {
  test('values', () => {
    expect(optimalBarWidth(10, 1)).toBe(3);
    expect(optimalBarWidth(10, 2)).toBe(6);
    expect(optimalBarWidth(6, 1)).toBe(1);
  });
});

describe('optimalCandlestickWidth — 2.5–4 plateau + atan taper (study 06 §4.8)', () => {
  test('plateau returns floor(3·pr)', () => {
    expect(optimalCandlestickWidth(3, 1)).toBe(3);
    expect(optimalCandlestickWidth(4, 1)).toBe(3);
  });
  test('taper outside the plateau', () => {
    expect(optimalCandlestickWidth(2, 1)).toBe(2);
    expect(optimalCandlestickWidth(5, 1)).toBe(4);
    expect(optimalCandlestickWidth(10, 1)).toBe(8);
  });
});

describe('applyBarParity — decrement when width ≥ 2 and parity differs from the ref line', () => {
  test('values', () => {
    expect(applyBarParity(4, 1)).toBe(3); // even vs odd ref → decrement
    expect(applyBarParity(4, 2)).toBe(4); // even vs even ref → keep
    expect(applyBarParity(3, 1)).toBe(3); // odd vs odd ref → keep
    expect(applyBarParity(3, 2)).toBe(2); // odd vs even ref → decrement
    expect(applyBarParity(1, 2)).toBe(1); // width < 2 → never changed
  });
});

describe('evenFloor / evenCeil — nearest even toward/away from zero', () => {
  test('values', () => {
    expect(evenFloor(5)).toBe(4);
    expect(evenFloor(4)).toBe(4);
    expect(evenCeil(5)).toBe(6);
    expect(evenCeil(4)).toBe(4);
  });
});

describe('ceiledOdd / ceiledEven — ceil then shrink by 1 on parity mismatch (study 08 §4.4)', () => {
  test('values', () => {
    expect(ceiledOdd(12)).toBe(11);
    expect(ceiledOdd(12.3)).toBe(13);
    expect(ceiledOdd(11)).toBe(11);
    expect(ceiledEven(12)).toBe(12);
    expect(ceiledEven(12.3)).toBe(12);
    expect(ceiledEven(11)).toBe(10);
  });
});
