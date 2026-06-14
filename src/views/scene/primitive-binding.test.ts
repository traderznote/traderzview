import { describe, expect, test } from 'vitest';
import { PrimitiveBinding, resolveSurface } from './primitive-binding';
import type { OwnerPlacement, TaggedPrimitiveSource } from './primitive-binding';
import { ZBand } from '../../gfx';
import type { DisplayList, SceneSource, ViewFrame } from '../../gfx';

function fakeSource(zBand: ZBand): SceneSource {
  const lists: readonly DisplayList[] = [];
  return {
    zBand,
    update(_f: ViewFrame) {},
    displayLists: () => lists,
  };
}

function tagged(target: TaggedPrimitiveSource['target'], axis?: 'left' | 'right'): TaggedPrimitiveSource {
  return { target, axis, source: fakeSource(ZBand.AboveSeries) };
}

const onRight: OwnerPlacement = { paneId: 'p0', priceScaleId: 'right', axisSide: 'right' };
const onLeft: OwnerPlacement = { paneId: 'p0', priceScaleId: 'left', axisSide: 'left' };
const onOverlay: OwnerPlacement = { paneId: 'p0', priceScaleId: null, axisSide: null };

describe('resolveSurface', () => {
  test("a 'pane' target always homes to the pane surface", () => {
    expect(resolveSurface(tagged('pane'), onOverlay)).toBe('pane');
  });

  test("a 'time-axis' target homes to the shared time-axis surface", () => {
    expect(resolveSurface(tagged('time-axis'), onRight)).toBe('time-axis');
  });

  test("a 'price-axis' target follows the owner's current scale side", () => {
    expect(resolveSurface(tagged('price-axis'), onRight)).toBe('price-axis-right');
    expect(resolveSurface(tagged('price-axis'), onLeft)).toBe('price-axis-left');
  });

  test("an explicit axis selector overrides the owner's scale side", () => {
    expect(resolveSurface(tagged('price-axis', 'left'), onRight)).toBe('price-axis-left');
  });

  test('a price-axis source on an overlay scale (no axis side) renders nowhere', () => {
    expect(resolveSurface(tagged('price-axis'), onOverlay)).toBeNull();
  });
});

describe('PrimitiveBinding — re-home without re-firing attached/detached', () => {
  test('keeps the SAME source object identity across a re-home', () => {
    const t = tagged('price-axis');
    const binding = new PrimitiveBinding(t, onRight);
    const src = binding.source();
    expect(binding.surfaceKey()).toBe('price-axis-right');

    binding.rehome(onLeft);
    expect(binding.source()).toBe(src); // identical SceneSource — no detach/re-attach
    expect(binding.surfaceKey()).toBe('price-axis-left');
  });

  test('rehome returns the previous surface key and reports whether the source moved', () => {
    const binding = new PrimitiveBinding(tagged('price-axis'), onRight);
    const prev = binding.rehome(onLeft); // right → left
    expect(prev).toBe('price-axis-right');
    expect(binding.movedFrom(prev)).toBe(true);

    const prev2 = binding.rehome(onLeft); // left → left (priceScaleId unchanged)
    expect(prev2).toBe('price-axis-left');
    expect(binding.movedFrom(prev2)).toBe(false); // stayed put
  });

  test('a moveToPane change updates placement; pane-target source stays on the pane surface', () => {
    const binding = new PrimitiveBinding(tagged('pane'), onRight);
    expect(binding.surfaceKey()).toBe('pane');
    const moved: OwnerPlacement = { paneId: 'p1', priceScaleId: 'right', axisSide: 'right' };
    binding.rehome(moved);
    expect(binding.surfaceKey()).toBe('pane'); // target tag drives the surface, not the pane id
    expect(binding.placement().paneId).toBe('p1'); // placement tracked for the host
  });

  test('a price-axis source becomes homeless when the owner moves onto an overlay scale', () => {
    const binding = new PrimitiveBinding(tagged('price-axis'), onRight);
    expect(binding.surfaceKey()).toBe('price-axis-right');
    const prev = binding.rehome(onOverlay);
    expect(prev).toBe('price-axis-right');
    expect(binding.surfaceKey()).toBeNull(); // renders nowhere while on overlay
    expect(binding.movedFrom(prev)).toBe(true);
  });

  test('exposes the source z-band for PaneScene registration', () => {
    const binding = new PrimitiveBinding(tagged('pane'), onRight);
    expect(binding.zBand()).toBe(ZBand.AboveSeries);
  });
});
