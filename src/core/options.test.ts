import { describe, expect, test } from 'vitest';
import { changedPaths, mergeOptions } from './options';

// The six merge laws (architecture §4.3), plus no-mutation and changed-path set.

describe('mergeOptions — law 1: undefined in patch is ignored', () => {
  test('keeps the current (base) value', () => {
    expect(mergeOptions({ a: 1, b: 2 }, { a: undefined }, { a: 0, b: 0 })).toEqual({ a: 1, b: 2 });
  });
});

describe('mergeOptions — law 2: leaf null resets to the default', () => {
  test('a null leaf is replaced by the defaults value', () => {
    expect(mergeOptions({ a: 5 }, { a: null }, { a: 99 })).toEqual({ a: 99 });
  });

  test('null resets only the targeted leaf, not siblings', () => {
    expect(mergeOptions({ a: 5, b: 6 }, { a: null }, { a: 99, b: 0 })).toEqual({ a: 99, b: 6 });
  });
});

describe('mergeOptions — law 3: plain objects merge recursively', () => {
  test('nested keys merge; untouched nested keys survive', () => {
    expect(mergeOptions({ a: { x: 1, y: 2 } }, { a: { y: 9 } }, { a: { x: 0, y: 0 } })).toEqual({
      a: { x: 1, y: 9 },
    });
  });
});

describe('mergeOptions — law 4: arrays, functions, instances assign by reference', () => {
  test('array is stored by reference (not cloned)', () => {
    const arr = [1, 2, 3];
    const merged = mergeOptions<{ a: number[] }>({ a: [0] }, { a: arr }, { a: [] });
    expect(merged.a).toBe(arr);
  });

  test('function is stored by reference', () => {
    const fn = (): number => 1;
    const merged = mergeOptions<{ a: () => number }>({ a: () => 0 }, { a: fn }, { a: () => 0 });
    expect(merged.a).toBe(fn);
  });

  test('class instance is stored by reference', () => {
    const when = new Date(0);
    const merged = mergeOptions<{ a: Date }>({ a: new Date(1) }, { a: when }, { a: new Date(2) });
    expect(merged.a).toBe(when);
  });
});

describe('mergeOptions — law 5: prototype-pollution keys are rejected', () => {
  test('an own __proto__ key throws and does not pollute Object.prototype', () => {
    const evil = JSON.parse('{"__proto__": {"polluted": true}}');
    expect(() => mergeOptions({}, evil, {})).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test('a constructor key throws', () => {
    expect(() => mergeOptions({}, { constructor: 1 } as Record<string, unknown>, {})).toThrow();
  });
});

describe('mergeOptions — law 6: never alias the user-supplied object graph', () => {
  test('a nested plain object from the patch is cloned, not aliased', () => {
    const patch = { a: { x: 1 } };
    const merged = mergeOptions({ a: { x: 0, y: 0 } }, patch, { a: { x: 0, y: 0 } });
    patch.a.x = 999; // mutate the user's object after merge
    expect(merged.a.x).toBe(1); // merged is unaffected → it was cloned
  });
});

describe('mergeOptions — never mutates its inputs', () => {
  test('base is left unchanged', () => {
    const base = { a: { x: 1 }, b: 2 };
    mergeOptions(base, { b: 9 }, { a: { x: 0 }, b: 0 });
    expect(base).toEqual({ a: { x: 1 }, b: 2 });
  });

  test('works on deeply frozen inputs (dev builds may freeze)', () => {
    const base = Object.freeze({ a: Object.freeze({ x: 1 }) });
    const patch = Object.freeze({ a: Object.freeze({ x: 2 }) });
    expect(() => mergeOptions(base, patch, base)).not.toThrow();
    expect(mergeOptions(base, patch, base)).toEqual({ a: { x: 2 } });
  });
});

describe('changedPaths — dot-paths of leaves that actually changed', () => {
  test('reports only the changed nested leaf', () => {
    expect([...changedPaths({ a: { b: 1, c: 2 } }, { a: { b: 9, c: 2 } })]).toEqual(['a.b']);
  });

  test('no changes → empty set', () => {
    expect(changedPaths({ a: 1, b: 2 }, { a: 1, b: 2 }).size).toBe(0);
  });

  test('a by-reference value counts as changed when the reference differs', () => {
    expect([...changedPaths({ a: [1] }, { a: [1] })]).toEqual(['a']);
  });
});
