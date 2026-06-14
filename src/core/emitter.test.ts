import { afterEach, describe, expect, test } from 'vitest';
import { Emitter } from './emitter';
import { setReportError } from './report-error';

afterEach(() => setReportError(null));

describe('Emitter', () => {
  test('fire invokes subscribers with the args', () => {
    const e = new Emitter<[number, string]>();
    const calls: Array<[number, string]> = [];
    e.subscribe((n, s) => calls.push([n, s]));
    e.fire(1, 'a');
    expect(calls).toEqual([[1, 'a']]);
  });

  test('the returned unsubscribe function removes the listener', () => {
    const e = new Emitter();
    let n = 0;
    const off = e.subscribe(() => { n++; });
    e.fire();
    off();
    e.fire();
    expect(n).toBe(1);
  });

  test('a listener subscribed during fire does not run that round', () => {
    const e = new Emitter();
    let added = 0;
    e.subscribe(() => { e.subscribe(() => { added++; }); });
    e.fire();
    expect(added).toBe(0);
    e.fire();
    expect(added).toBe(1);
  });

  test('once listeners run exactly once and are pre-removed', () => {
    const e = new Emitter();
    let n = 0;
    e.subscribe(() => { n++; }, { once: true });
    e.fire();
    e.fire();
    expect(n).toBe(1);
    expect(e.hasListeners()).toBe(false);
  });

  test('a throwing listener does not stop dispatch; the error is reported', () => {
    const seen: unknown[] = [];
    setReportError((err) => seen.push(err));
    const e = new Emitter();
    const boom = new Error('boom');
    let reached = false;
    e.subscribe(() => { throw boom; });
    e.subscribe(() => { reached = true; });
    e.fire();
    expect(reached).toBe(true);
    expect(seen).toEqual([boom]);
  });

  test('a once listener is removed even if an earlier listener throws', () => {
    setReportError(() => {});
    const e = new Emitter();
    let onceRuns = 0;
    e.subscribe(() => { throw new Error('x'); });
    e.subscribe(() => { onceRuns++; }, { once: true });
    e.fire();
    e.fire();
    expect(onceRuns).toBe(1);
  });

  test('unsubscribeAll(owner) removes all listeners tagged with that owner', () => {
    const e = new Emitter();
    const owner = {};
    let a = 0;
    let b = 0;
    e.subscribe(() => { a++; }, { owner });
    e.subscribe(() => { b++; }, { owner });
    const other = e.subscribe(() => {});
    e.unsubscribeAll(owner);
    e.fire();
    expect(a).toBe(0);
    expect(b).toBe(0);
    expect(e.hasListeners()).toBe(true);
    other();
  });

  test('hasListeners reflects subscription state; dispose clears all', () => {
    const e = new Emitter();
    expect(e.hasListeners()).toBe(false);
    e.subscribe(() => {});
    expect(e.hasListeners()).toBe(true);
    e.dispose();
    expect(e.hasListeners()).toBe(false);
  });

  test('fireLazy builds the payload only when there are listeners', () => {
    const e = new Emitter<[number]>();
    let builds = 0;
    e.fireLazy(() => { builds++; return [1]; });
    expect(builds).toBe(0);
    let got = 0;
    e.subscribe((n) => { got = n; });
    e.fireLazy(() => { builds++; return [7]; });
    expect(builds).toBe(1);
    expect(got).toBe(7);
  });
});
