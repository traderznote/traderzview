import { describe, expect, test } from 'vitest';
import { lowerBound, upperBound } from './search';

// Comparators for a sorted number[] (study 10 §4.1 spec of record):
//   lowerBound's compare means "item < value"; upperBound's means "item > value".
const lt = (a: number, v: number): boolean => a < v;
const gt = (a: number, v: number): boolean => a > v;

describe('lowerBound — first index whose element is NOT < value', () => {
  test('duplicates: returns the first matching index', () => {
    expect(lowerBound([10, 20, 20, 20, 30], 20, lt)).toBe(1);
  });

  test('exact unique hit', () => {
    expect(lowerBound([10, 20, 30], 30, lt)).toBe(2);
  });

  test('miss-left: value below all elements → 0', () => {
    expect(lowerBound([10, 20, 30], 5, lt)).toBe(0);
  });

  test('miss-right: value above all elements → length', () => {
    expect(lowerBound([10, 20, 30], 35, lt)).toBe(3);
  });

  test('gap: value between elements → first greater index', () => {
    expect(lowerBound([10, 20, 30], 25, lt)).toBe(2);
  });

  test('empty array → 0', () => {
    expect(lowerBound([], 1, lt)).toBe(0);
  });

  test('single element: equal → 0, above → 1, below → 0', () => {
    expect(lowerBound([42], 42, lt)).toBe(0);
    expect(lowerBound([42], 50, lt)).toBe(1);
    expect(lowerBound([42], 10, lt)).toBe(0);
  });

  test('all-equal → 0', () => {
    expect(lowerBound([7, 7, 7], 7, lt)).toBe(0);
  });
});

describe('upperBound — first index whose element IS > value', () => {
  test('duplicates: returns the index just past the last match', () => {
    expect(upperBound([10, 20, 20, 20, 30], 20, gt)).toBe(4);
  });

  test('miss-left: value below all elements → 0', () => {
    expect(upperBound([10, 20, 30], 5, gt)).toBe(0);
  });

  test('miss-right: value above all elements → length', () => {
    expect(upperBound([10, 20, 30], 35, gt)).toBe(3);
  });

  test('empty array → 0', () => {
    expect(upperBound([], 1, gt)).toBe(0);
  });

  test('single element: equal → 1, below → 0', () => {
    expect(upperBound([42], 42, gt)).toBe(1);
    expect(upperBound([42], 10, gt)).toBe(0);
  });

  test('all-equal → length', () => {
    expect(upperBound([7, 7, 7], 7, gt)).toBe(3);
  });
});

describe('sub-range [start, to)', () => {
  test('lowerBound searches only the given window', () => {
    const arr = [0, 10, 20, 20, 30, 40];
    // window [1,5) = elements 10,20,20,30 → first index >= 20 is 2
    expect(lowerBound(arr, 20, lt, 1, 5)).toBe(2);
  });

  test('upperBound searches only the given window', () => {
    const arr = [0, 10, 20, 20, 30, 40];
    // window [1,5) → first index > 20 is 4
    expect(upperBound(arr, 20, gt, 1, 5)).toBe(4);
  });
});
