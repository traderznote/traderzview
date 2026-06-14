import { afterEach, expect, test } from 'vitest';
import { reportError, setReportError } from './report-error';

// Restore the default reporter after each test (the default rethrows on a
// microtask; we never invoke it directly here to avoid an async throw).
afterEach(() => setReportError(null));

test('routes the error to a custom reporter', () => {
  const seen: unknown[] = [];
  setReportError((e) => seen.push(e));
  const err = new Error('boom');
  reportError(err);
  expect(seen).toEqual([err]);
});

test('setReportError replaces the previous reporter', () => {
  const a: unknown[] = [];
  const b: unknown[] = [];
  setReportError((e) => a.push(e));
  setReportError((e) => b.push(e));
  reportError('x');
  expect(a).toEqual([]);
  expect(b).toEqual(['x']);
});
