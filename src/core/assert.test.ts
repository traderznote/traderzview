import { describe, expect, test } from 'vitest';
import { assert } from './assert';

// Tests run with __DEV__ defined true (vitest.config.ts), so assertions are live.
describe('assert (dev-only)', () => {
  test('throws when the condition is falsy', () => {
    expect(() => assert(false, 'must be present')).toThrow('must be present');
  });

  test('does not throw when the condition is truthy', () => {
    expect(() => assert(true, 'ok')).not.toThrow();
  });

  test('narrows the asserted type', () => {
    const x: number | null = 5 as number | null;
    assert(x !== null, 'x is present');
    // Compiles only because assert narrows x to number; runtime confirms no-throw.
    expect(x + 1).toBe(6);
  });
});
