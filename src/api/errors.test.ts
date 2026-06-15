import { expect, test } from 'vitest';
import { ChartError, ChartErrorCode, throwChartError } from './errors';

// Spec of record: 02-public-api-spec.md §16. The taxonomy is hand-derived from
// §16's code list — exactly these ten, each with a specified throw site. Codes
// are lowercase kebab-case (§4.2 string-union policy).
const ALL_CODES = [
  'container-not-found',
  'disposed',
  'invalid-data-order',
  'non-finite-value',
  'value-out-of-bounds',
  'mixed-time-kinds',
  'invalid-date-string',
  'stale-update',
  'unknown-series-definition',
  'no-such-scale',
] as const;

test('ChartErrorCode enumerates exactly the §16 codes, no more no fewer', () => {
  expect(new Set(Object.values(ChartErrorCode))).toEqual(new Set(ALL_CODES));
  expect(Object.values(ChartErrorCode)).toHaveLength(ALL_CODES.length);
});

test('every code constructs a ChartError that carries that code', () => {
  for (const code of ALL_CODES) {
    const err = new ChartError(code);
    expect(err.code).toBe(code);
  }
});

test('ChartError is an Error subclass with name "ChartError"', () => {
  const err = new ChartError('disposed');
  expect(err).toBeInstanceOf(Error);
  expect(err).toBeInstanceOf(ChartError);
  expect(err.name).toBe('ChartError');
  // instanceof survives the Error super-call (prototype restored).
  expect(Object.getPrototypeOf(err)).toBe(ChartError.prototype);
});

test('message defaults to the code; explicit message is preserved', () => {
  expect(new ChartError('no-such-scale').message).toBe('no-such-scale');
  expect(new ChartError('no-such-scale', 'overlay').message).toBe('overlay');
});

test('disposed shape: every post-dispose facade call throws this (§16.5)', () => {
  const err = new ChartError(ChartErrorCode.Disposed);
  expect(err.code).toBe('disposed');
  expect(err).toBeInstanceOf(ChartError);
});

test('container-not-found shape carries the id in the message (§3.1)', () => {
  // The factory throws with the missing id in the message; .code stays clean.
  const err = throwBack(() => throwChartError('container-not-found', '#chart'));
  expect(err.code).toBe('container-not-found');
  expect(err.message).toContain('#chart');
  expect(err.message).toContain('container-not-found');
});

test('throwChartError throws a ChartError with the code; no detail → code message', () => {
  expect(() => throwChartError('stale-update')).toThrow(ChartError);
  const err = throwBack(() => throwChartError('stale-update'));
  expect(err.code).toBe('stale-update');
  expect(err.message).toBe('stale-update');
});

test('throwChartError detail is appended after the code (§15.2 index + keys)', () => {
  const err = throwBack(() => throwChartError('invalid-data-order', 'item 3: 100 <= 100'));
  expect(err.code).toBe('invalid-data-order');
  expect(err.message).toBe('invalid-data-order: item 3: 100 <= 100');
});

test('code discriminant is stable independent of the message', () => {
  const a = new ChartError('non-finite-value', 'whatever the message says');
  expect(a.code).toBe('non-finite-value');
  expect(a.message).not.toBe(a.code);
});

// Helper: capture the thrown ChartError so we can assert its fields.
function throwBack(fn: () => never): ChartError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ChartError);
    return e as ChartError;
  }
  throw new Error('expected fn to throw');
}
