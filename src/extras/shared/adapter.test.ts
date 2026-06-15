// Spec of record: design 02 §12.4 (the {detach, applyOptions} + factory-method adapter,
// standard §5.1 merge) + design 05 §2.2 (detach idempotent + total: detached EXACTLY
// once, double-detach a no-op). Headless: a recording PrimitiveTarget over the PUBLIC
// api IPrimitive + a stub primitive — no DOM, no gfx, no model. Every assertion is
// hand-derived from those contracts.
import { describe, expect, test, vi } from 'vitest';
import type { IPrimitive } from '../../api';
import { createPrimitiveAdapter, type PrimitiveTarget } from './adapter';

// --- a recording target: counts/records attach & detach of each primitive identity ---
function makeTarget(): PrimitiveTarget & { attached: IPrimitive[]; detached: IPrimitive[] } {
  const attached: IPrimitive[] = [];
  const detached: IPrimitive[] = [];
  return {
    attached,
    detached,
    attachPrimitive(p): void {
      attached.push(p);
    },
    detachPrimitive(p): void {
      detached.push(p);
    },
  };
}

// A trivially-valid primitive ({} is a valid IPrimitive, §12) — identity is all the
// adapter keys on, so an empty object is the strongest test of the attach/detach pairing.
const stubPrimitive = (): IPrimitive => ({});

interface Opts {
  color: string;
  size: number;
  shape: { kind: string; outline: boolean };
  ids: number[];
}
const DEFAULTS: Opts = { color: 'red', size: 10, shape: { kind: 'circle', outline: true }, ids: [1, 2] };

describe('extras/shared adapter convention (§12.4 / §2.2)', () => {
  test('construction attaches the primitive to its owner exactly once (§2.2 attach)', () => {
    const target = makeTarget();
    const primitive = stubPrimitive();
    createPrimitiveAdapter({
      target,
      primitive,
      options: { ...DEFAULTS },
      defaults: DEFAULTS,
      onChange: () => {},
      methods: {},
    });
    expect(target.attached).toEqual([primitive]); // attached once, with THIS identity
    expect(target.detached).toEqual([]); // nothing detached on construction
  });

  test('detach() forwards detachPrimitive(primitive) exactly once; double-detach is a no-op (§2.2)', () => {
    const target = makeTarget();
    const primitive = stubPrimitive();
    const adapter = createPrimitiveAdapter({
      target,
      primitive,
      options: { ...DEFAULTS },
      defaults: DEFAULTS,
      onChange: () => {},
      methods: {},
    });

    adapter.detach();
    expect(target.detached).toEqual([primitive]); // exactly-once, same identity that was attached
    adapter.detach(); // double-detach
    adapter.detach(); // triple, for good measure
    expect(target.detached).toEqual([primitive]); // still exactly one — idempotent + total
  });

  test('onDetach runs exactly once, BEFORE detachPrimitive (§2.2 ordering)', () => {
    const target = makeTarget();
    const primitive = stubPrimitive();
    const order: string[] = [];
    target.detachPrimitive = (p): void => {
      order.push('detachPrimitive');
      target.detached.push(p);
    };
    const adapter = createPrimitiveAdapter({
      target,
      primitive,
      options: { ...DEFAULTS },
      defaults: DEFAULTS,
      onChange: () => {},
      methods: {},
      onDetach: () => order.push('onDetach'),
    });

    adapter.detach();
    adapter.detach(); // idempotent — onDetach must NOT run a second time
    expect(order).toEqual(['onDetach', 'detachPrimitive']); // own teardown precedes unregister, once
  });

  test('applyOptions runs the standard §5.1 deep-merge and forwards the merged result to onChange', () => {
    const target = makeTarget();
    const onChange = vi.fn<(o: Opts) => void>();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { color: 'red', size: 10, shape: { kind: 'circle', outline: true }, ids: [1, 2] },
      defaults: DEFAULTS,
      onChange,
      methods: {},
    });

    const newIds = [9];
    adapter.applyOptions({ size: 42, shape: { kind: 'square' }, ids: newIds });
    expect(onChange).toHaveBeenCalledTimes(1);
    const merged = onChange.mock.calls[0][0];
    // recurse into shape (kind overridden, outline preserved); scalar replaced; array by reference (§5.1 law 4)
    expect(merged).toEqual({ color: 'red', size: 42, shape: { kind: 'square', outline: true }, ids: [9] });
    expect(merged.ids).toBe(newIds); // arrays assign by reference, never deep-merged
  });

  test('applyOptions(null leaf) resets that leaf to its effective default (§5.1 law 2)', () => {
    const target = makeTarget();
    const onChange = vi.fn<(o: Opts) => void>();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { color: 'blue', size: 99, shape: { kind: 'square', outline: false }, ids: [7] },
      defaults: DEFAULTS,
      onChange,
      methods: {},
    });

    adapter.applyOptions({ color: null }); // leaf-null → reset to default 'red'
    expect(onChange.mock.calls[0][0].color).toBe('red');
  });

  test('a no-op patch does NOT invalidate — onChange is not called (§5.1 unchanged = no-op)', () => {
    const target = makeTarget();
    const onChange = vi.fn<(o: Opts) => void>();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { ...DEFAULTS, shape: { ...DEFAULTS.shape } },
      defaults: DEFAULTS,
      onChange,
      methods: {},
    });

    adapter.applyOptions({}); // empty patch
    adapter.applyOptions({ size: 10 }); // same value as current
    adapter.applyOptions({ shape: { kind: 'circle' } }); // same nested value
    expect(onChange).not.toHaveBeenCalled();
  });

  test('options are accumulated across applyOptions calls (the adapter holds the live merged state)', () => {
    const target = makeTarget();
    const onChange = vi.fn<(o: Opts) => void>();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { ...DEFAULTS, shape: { ...DEFAULTS.shape } },
      defaults: DEFAULTS,
      onChange,
      methods: {},
    });

    adapter.applyOptions({ size: 20 });
    adapter.applyOptions({ color: 'green' });
    // the second merge sees the first merge's result, not the original options
    expect(onChange.mock.calls[1][0]).toEqual({
      color: 'green',
      size: 20,
      shape: { kind: 'circle', outline: true },
      ids: [1, 2],
    });
  });

  test('factory-specific methods are spread onto the returned handle alongside detach/applyOptions', () => {
    const target = makeTarget();
    const setMarkers = vi.fn();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { ...DEFAULTS },
      defaults: DEFAULTS,
      onChange: () => {},
      methods: { setMarkers, markers: () => [1, 2, 3] },
    });

    expect(typeof adapter.detach).toBe('function');
    expect(typeof adapter.applyOptions).toBe('function');
    expect(typeof adapter.setMarkers).toBe('function');
    adapter.setMarkers('x');
    expect(setMarkers).toHaveBeenCalledWith('x');
    expect(adapter.markers()).toEqual([1, 2, 3]);
  });

  test('user patch is never aliased into stored state (§5.1 law 6 — cloned at the boundary)', () => {
    const target = makeTarget();
    let stored: Opts | null = null;
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { ...DEFAULTS, shape: { ...DEFAULTS.shape } },
      defaults: DEFAULTS,
      onChange: (o) => {
        stored = o;
      },
      methods: {},
    });

    const patch = { shape: { kind: 'triangle' } };
    adapter.applyOptions(patch);
    patch.shape.kind = 'MUTATED'; // mutate the user's patch object after the call
    expect((stored as unknown as Opts).shape.kind).toBe('triangle'); // stored state unaffected
  });
});
