import { describe, expect, test, vi } from 'vitest';
import {
  EventHub,
  buildHoverInfo,
  buildSeriesData,
  surfaceStoreDiff,
} from './events';
import type { HoverOwnership, MouseEventParams, StoreDiff } from './events';
import { setReportError } from '../core';
import type { Logical, TimeIndex } from '../core';
import type { HoverTarget } from '../model';

// Spec of record: 02-public-api-spec.md §14 (Events). Tests are hand-derived from
// the §14.1 lazy-build rule, the §14.2 seriesData keying + whitespace exclusion +
// kind derivation, and the §14.3 TimeIndex→Logical surfacing. Headless: no DOM, no
// canvas — fakes for series handles and hover targets only.

// A stand-in series handle: identity is all the map keying cares about.
function fakeSeries(name: string): { name: string } {
  return { name };
}

// =====================================================================================
// §14.1 — every payload is built LAZILY behind hasListeners()
// =====================================================================================

describe('§14.1 lazy payload build', () => {
  test('emit does NOT run the build thunk when there are no listeners', () => {
    const hub = new EventHub<[number]>();
    const build = vi.fn(() => [1] as [number]);
    expect(hub.hasListeners()).toBe(false);
    hub.emit(build);
    expect(build).not.toHaveBeenCalled();
  });

  test('emit runs the build thunk exactly once when listeners exist', () => {
    const hub = new EventHub<[number]>();
    const seen: number[] = [];
    hub.subscribe((n) => seen.push(n));
    hub.subscribe((n) => seen.push(n * 10));
    const build = vi.fn(() => [7] as [number]);
    hub.emit(build);
    // Built ONCE (not per-listener); both listeners see the same payload.
    expect(build).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([7, 70]);
  });

  test('after the last listener unsubscribes, build is skipped again', () => {
    const hub = new EventHub<[]>();
    const off = hub.subscribe(() => {});
    off();
    const build = vi.fn(() => [] as []);
    hub.emit(build);
    expect(build).not.toHaveBeenCalled();
    expect(hub.hasListeners()).toBe(false);
  });
});

// =====================================================================================
// §14.1 — subscribe returns Unsubscribe AND unsubscribe(handler) removes the same reg
// =====================================================================================

describe('§14.1 subscribe / unsubscribe pairs', () => {
  test('subscribe returns an Unsubscribe that removes the listener', () => {
    const hub = new EventHub<[number]>();
    const seen: number[] = [];
    const off = hub.subscribe((n) => seen.push(n));
    hub.emit(() => [1]);
    off();
    hub.emit(() => [2]);
    expect(seen).toEqual([1]);
  });

  test('unsubscribe(handler) removes by reference (reference parity)', () => {
    const hub = new EventHub<[number]>();
    const seen: number[] = [];
    const handler = (n: number): void => void seen.push(n);
    hub.subscribe(handler);
    hub.emit(() => [1]);
    hub.unsubscribe(handler);
    hub.emit(() => [2]);
    expect(seen).toEqual([1]);
    expect(hub.hasListeners()).toBe(false);
  });

  test('unsubscribe is a no-op for a never-subscribed / already-removed handler', () => {
    const hub = new EventHub<[]>();
    const handler = (): void => {};
    expect(() => hub.unsubscribe(handler)).not.toThrow();
    hub.subscribe(handler);
    hub.unsubscribe(handler);
    expect(() => hub.unsubscribe(handler)).not.toThrow();
    expect(hub.hasListeners()).toBe(false);
  });

  test('a throwing listener does not stop dispatch (Emitter delegate semantics)', () => {
    const hub = new EventHub<[]>();
    const seen: string[] = [];
    // Capture the routed error deterministically instead of letting the default
    // microtask-rethrow escape the test run (§14.1: error → reportError hook).
    const errors: unknown[] = [];
    setReportError((e) => void errors.push(e));
    try {
      hub.subscribe(() => {
        throw new Error('boom');
      });
      hub.subscribe(() => seen.push('reached'));
      expect(() => hub.emit(() => [])).not.toThrow();
    } finally {
      setReportError(null);
    }
    expect(seen).toEqual(['reached']); // a later listener still ran
    expect(errors).toHaveLength(1); // the throw was routed, not swallowed
  });

  test('dispose tears down all listeners', () => {
    const hub = new EventHub<[]>();
    hub.subscribe(() => {});
    hub.subscribe(() => {});
    hub.dispose();
    expect(hub.hasListeners()).toBe(false);
    const build = vi.fn(() => [] as []);
    hub.emit(build);
    expect(build).not.toHaveBeenCalled();
  });
});

// =====================================================================================
// §14.2 — seriesData keyed by user handles, whitespace excluded
// =====================================================================================

describe('§14.2 buildSeriesData', () => {
  test('keys entries by the user series handle (identity preserved)', () => {
    const a = fakeSeries('a');
    const b = fakeSeries('b');
    const map = buildSeriesData([
      { series: a, item: { value: 10 } },
      { series: b, item: { value: 20 } },
    ]);
    expect(map.get(a)).toEqual({ value: 10 });
    expect(map.get(b)).toEqual({ value: 20 });
    expect(map.size).toBe(2);
  });

  test('whitespace (null item) is excluded; no-data (undefined item) excluded', () => {
    const a = fakeSeries('a');
    const b = fakeSeries('b');
    const c = fakeSeries('c');
    const map = buildSeriesData([
      { series: a, item: { value: 1 } },
      { series: b, item: null }, // whitespace slot
      { series: c, item: undefined }, // series has no data at slot
    ]);
    expect(map.has(a)).toBe(true);
    expect(map.has(b)).toBe(false);
    expect(map.has(c)).toBe(false);
    expect(map.size).toBe(1);
  });

  test('insertion order of candidates is preserved in the map', () => {
    const a = fakeSeries('a');
    const b = fakeSeries('b');
    const map = buildSeriesData([
      { series: b, item: { value: 2 } },
      { series: a, item: { value: 1 } },
    ]);
    expect([...map.keys()]).toEqual([b, a]);
  });

  test('a falsy-but-present item value (0) is NOT treated as whitespace', () => {
    // Only null/undefined items are whitespace; a real item carrying value 0 stays.
    const a = fakeSeries('a');
    const map = buildSeriesData([{ series: a, item: { value: 0 } }]);
    expect(map.get(a)).toEqual({ value: 0 });
  });
});

// =====================================================================================
// §14.2 — HoverInfo.kind derivation (series / price-line / primitive — no marker)
// =====================================================================================

describe('§14.2 buildHoverInfo kind derivation', () => {
  const target = (sourceId: string, externalId?: string): HoverTarget =>
    externalId === undefined ? { sourceId } : { sourceId, externalId };

  test("series source → kind 'series' with the owning series handle", () => {
    const s = fakeSeries('s');
    const resolve = (id: string): HoverOwnership<typeof s> | null =>
      id === 'series:1' ? { kind: 'series', series: s } : null;
    const info = buildHoverInfo(target('series:1'), 2, resolve);
    expect(info).toEqual({ kind: 'series', series: s, paneIndex: 2 });
  });

  test("price-line source → kind 'price-line' with externalId = the line id", () => {
    const s = fakeSeries('s');
    const resolve = (): HoverOwnership<typeof s> => ({ kind: 'price-line', series: s });
    const info = buildHoverInfo(target('pl:1', 'tp-line'), 0, resolve);
    expect(info).toEqual({
      kind: 'price-line',
      series: s,
      externalId: 'tp-line',
      paneIndex: 0,
    });
  });

  test("primitive source → kind 'primitive' with externalId = HitCandidate.externalId, no series", () => {
    const resolve = (): HoverOwnership<unknown> => ({ kind: 'primitive' });
    const info = buildHoverInfo(target('prim:7', 'marker-42'), 1, resolve);
    expect(info).toEqual({ kind: 'primitive', externalId: 'marker-42', paneIndex: 1 });
    // No series key for an unowned primitive.
    expect(info && 'series' in info).toBe(false);
  });

  test("derivation NEVER yields a 'marker' kind (markers report 'primitive', §18.13)", () => {
    const resolve = (): HoverOwnership<unknown> => ({ kind: 'primitive' });
    const info = buildHoverInfo(target('marker:9', 'm-1'), 0, resolve);
    expect(info?.kind).toBe('primitive');
    expect(info?.kind).not.toBe('marker' as unknown);
  });

  test('unknown source (not library-owned) → null, so no hoveredInfo is reported', () => {
    const resolve = (): null => null;
    expect(buildHoverInfo(target('foreign'), 0, resolve)).toBeNull();
  });

  test('externalId is omitted (not undefined) when the target carries none', () => {
    const resolve = (): HoverOwnership<unknown> => ({ kind: 'primitive' });
    const info = buildHoverInfo(target('prim:1'), 0, resolve);
    expect(info && 'externalId' in info).toBe(false);
  });
});

// =====================================================================================
// §14.3 — StoreDiff surfacing with TimeIndex → Logical brand
// =====================================================================================

describe('§14.3 surfaceStoreDiff', () => {
  test('slot-less variants pass through with the same kind', () => {
    expect(surfaceStoreDiff({ kind: 'replace' })).toEqual({ kind: 'replace' });
    expect(surfaceStoreDiff({ kind: 'append', count: 3 })).toEqual({ kind: 'append', count: 3 });
    expect(surfaceStoreDiff({ kind: 'updateLast' })).toEqual({ kind: 'updateLast' });
  });

  test('insert surfaces atSlot with the same numeric value (TimeIndex → Logical)', () => {
    const out = surfaceStoreDiff({ kind: 'insert', atSlot: 5 as TimeIndex });
    expect(out).toEqual({ kind: 'insert', atSlot: 5 });
    // The public type is Logical; runtime value is identical.
    const logical: Logical = (out as { kind: 'insert'; atSlot: Logical }).atSlot;
    expect(logical).toBe(5);
  });

  test('reindex surfaces fromSlot with the same numeric value', () => {
    const out = surfaceStoreDiff({ kind: 'reindex', fromSlot: 12 as TimeIndex });
    expect(out).toEqual({ kind: 'reindex', fromSlot: 12 });
  });

  test('slot-carrying variants return a fresh object (no aliasing of internal state)', () => {
    const internal = { kind: 'insert', atSlot: 1 as TimeIndex } as const;
    const out = surfaceStoreDiff(internal);
    expect(out).not.toBe(internal as unknown as StoreDiff);
  });

  test('the five public variants round-trip a hand-built MouseEventParams shape', () => {
    // A spot check that MouseEventParams composes the pieces (compile + shape only).
    const s = fakeSeries('s');
    const param: MouseEventParams<string, typeof s, { value: number }> = {
      logical: 4 as Logical,
      point: { x: 10 as never, y: 20 as never },
      paneIndex: 0,
      seriesData: buildSeriesData([{ series: s, item: { value: 9 } }]),
      hoveredInfo: { kind: 'series', series: s, paneIndex: 0 },
    };
    expect(param.seriesData.get(s)).toEqual({ value: 9 });
    expect(param.hoveredInfo?.kind).toBe('series');
  });
});
