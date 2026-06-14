import { describe, expect, test } from 'vitest';
import { PaneManager } from './pane-manager';
import { Pane } from './pane';

function mkManager(): PaneManager {
  return new PaneManager();
}

describe('Pane defaults (architecture §4.6, study 04)', () => {
  test('a fresh pane has the default left/right scale pair', () => {
    const p = new Pane('p0');
    expect(p.priceScale('right')).not.toBeNull();
    expect(p.priceScale('left')).not.toBeNull();
    expect(p.priceScale('right')!.options().visible).toBe(true);
    expect(p.priceScale('left')!.options().visible).toBe(false);
  });

  test('an overlay scale is created on demand for a non-left/right id', () => {
    const p = new Pane('p0');
    expect(p.priceScale('volume')).toBeNull();
    const ov = p.ensureOverlayScale('volume');
    expect(ov).not.toBeNull();
    expect(p.priceScale('volume')).toBe(ov);
  });

  test('stretch factor defaults to 1 and is settable', () => {
    const p = new Pane('p0');
    expect(p.stretchFactor()).toBe(1);
    p.setStretchFactor(2);
    expect(p.stretchFactor()).toBe(2);
  });

  test('series membership add/remove', () => {
    const p = new Pane('p0');
    const s = { kind: () => 'line' };
    p.addSeries(s);
    expect(p.series()).toContain(s);
    p.removeSeries(s);
    expect(p.series()).not.toContain(s);
  });
});

describe('PaneManager lifecycle (add/remove/move/swap)', () => {
  test('addPane appends and assigns ascending indices', () => {
    const m = mkManager();
    const a = m.addPane();
    const b = m.addPane();
    expect(m.panes()).toEqual([a, b]);
    expect(m.indexOf(a)).toBe(0);
    expect(m.indexOf(b)).toBe(1);
  });

  test('moveTo reorders and renumbers index() but keeps id() (design 02 §11)', () => {
    const m = mkManager();
    const a = m.addPane();
    const b = m.addPane();
    const c = m.addPane();
    const idA = a.id();
    m.moveTo(a, 2); // a → last
    expect(m.panes()).toEqual([b, c, a]);
    expect(a.id()).toBe(idA); // id survives a move
    expect(m.indexOf(a)).toBe(2);
  });

  test('moveTo out of bounds throws RangeError (design 02 §11)', () => {
    const m = mkManager();
    const a = m.addPane();
    expect(() => m.moveTo(a, 5)).toThrow(RangeError);
    expect(() => m.moveTo(a, -1)).toThrow(RangeError);
  });

  test('swapPanes exchanges positions but keeps ids', () => {
    const m = mkManager();
    const a = m.addPane();
    const b = m.addPane();
    const idA = a.id();
    const idB = b.id();
    m.swapPanes(0, 1);
    expect(m.panes()).toEqual([b, a]);
    expect(a.id()).toBe(idA);
    expect(b.id()).toBe(idB);
  });
});

describe('IPane.id() — never reused, survives remove/swap/move (05 A-4 / T8)', () => {
  test('add 3 panes, remove the middle, add another → ids never collide', () => {
    const m = mkManager();
    const p0 = m.addPane();
    const p1 = m.addPane();
    const p2 = m.addPane();
    expect([p0.id(), p1.id(), p2.id()]).toEqual(['p0', 'p1', 'p2']);

    m.removePane(p1); // remove the MIDDLE
    expect(m.panes()).toEqual([p0, p2]);

    const p3 = m.addPane(); // a new pane must NOT reuse 'p1'
    expect(p3.id()).toBe('p3');

    const ids = m.panes().map((p) => p.id());
    expect(new Set(ids).size).toBe(ids.length); // no collisions
    expect(ids).toEqual(['p0', 'p2', 'p3']);
  });

  test('ids survive swap then move (05 T8)', () => {
    const m = mkManager();
    const p0 = m.addPane();
    const p1 = m.addPane();
    const p2 = m.addPane();
    const before = m.panes().map((p) => p.id());
    m.swapPanes(0, 2);
    m.moveTo(m.panes()[0], 2);
    const after = new Set(m.panes().map((p) => p.id()));
    // same set of ids, just reordered — none minted afresh, none lost.
    expect(after).toEqual(new Set(before));
  });

  test('removing all panes then adding one still does not reuse an id', () => {
    const m = mkManager();
    const a = m.addPane();
    const b = m.addPane();
    m.removePane(a);
    m.removePane(b);
    const c = m.addPane();
    expect(c.id()).toBe('p2');
  });
});
