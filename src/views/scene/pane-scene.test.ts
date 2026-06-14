import { describe, expect, test } from 'vitest';
import { PaneScene } from './pane-scene';
import { ZBand } from '../../gfx';
import type { DisplayList, SceneSource, ViewFrame } from '../../gfx';

const FRAME: ViewFrame = {
  frame: { mediaSize: { width: 300, height: 200 }, bitmapSize: { width: 300, height: 200 }, hr: 1, vr: 1 },
  now: 0,
};

/** A controllable scene source. It returns ONE cached array while "clean"; calling
 *  `dirty()` makes the next `displayLists()` return a fresh array (a re-emit). One
 *  DisplayList carries a `tag` (via a text item) so tests can read composite order. */
class FakeSource implements SceneSource {
  readonly zBand: ZBand;
  #lists: readonly DisplayList[];
  #dirty = true;
  updates = 0;

  constructor(
    public readonly tag: string,
    zBand: ZBand,
  ) {
    this.zBand = zBand;
    this.#lists = this.#build();
  }

  #build(): readonly DisplayList[] {
    return [{ space: 'media', commands: [{ kind: 'text', items: [{ x: 0, y: 0, text: this.tag, font: { family: 's', size: 8 }, color: '#000' }] }] }];
  }

  update(_frame: ViewFrame): void {
    this.updates++;
    if (this.#dirty) {
      this.#lists = this.#build(); // re-emit: a NEW array reference
      this.#dirty = false;
    }
  }

  displayLists(): readonly DisplayList[] {
    return this.#lists; // identical reference while clean
  }

  dirty(): void {
    this.#dirty = true;
  }
}

function tagsOf(lists: readonly DisplayList[]): string[] {
  const out: string[] = [];
  for (const l of lists) {
    for (const c of l.commands) {
      if (c.kind === 'text') out.push(c.items[0]!.text);
    }
  }
  return out;
}

describe('PaneScene — per-source cache identity (perf §4.4.2)', () => {
  test('a CLEAN source returns the IDENTICAL cached array by reference; sourcesReEmitted == 0', () => {
    const scene = new PaneScene();
    const s = new FakeSource('s', ZBand.Series);
    scene.register(s, { ownerZ: 0, ownerId: 1 });

    // Frame 1: first emit (counts as a re-emit) and seeds the cache.
    scene.composite('base', FRAME);
    const cached1 = scene.cachedListsOf(s);
    expect(scene.sourcesReEmitted).toBe(1);

    // Frame 2: source stays CLEAN → identical array reference, zero re-emits.
    scene.composite('base', FRAME);
    const cached2 = scene.cachedListsOf(s);
    expect(cached2).toBe(cached1); // ZERO-TOLERANCE identity invariant
    expect(scene.sourcesReEmitted).toBe(0);
    expect(scene.assertCleanIdentity(s, cached1)).toBe(true);
    expect(scene.identityViolations).toBe(0);
  });

  test('a DIRTIED source re-emits a fresh array and is counted', () => {
    const scene = new PaneScene();
    const s = new FakeSource('s', ZBand.Series);
    scene.register(s, { ownerZ: 0, ownerId: 1 });
    scene.composite('base', FRAME);
    const before = scene.cachedListsOf(s);

    s.dirty();
    scene.composite('base', FRAME);
    const after = scene.cachedListsOf(s);
    expect(after).not.toBe(before); // fresh array
    expect(scene.sourcesReEmitted).toBe(1);
  });

  test('composite reuses each clean source DisplayList object by reference', () => {
    const scene = new PaneScene();
    const s = new FakeSource('s', ZBand.Series);
    scene.register(s, { ownerZ: 0, ownerId: 1 });
    scene.composite('base', FRAME);
    const list1 = s.displayLists()[0]!;
    const out = scene.composite('base', FRAME);
    expect(out[0]).toBe(list1); // same DisplayList object flows through
  });
});

describe('PaneScene — band membership / layer split', () => {
  test("composite('base') draws only bands 0–5; composite('overlay') only 6–8 (perf §4.4.1)", () => {
    const scene = new PaneScene();
    const grid = new FakeSource('grid', ZBand.Grid); // base
    const series = new FakeSource('series', ZBand.Series); // base
    const cross = new FakeSource('cross', ZBand.Crosshair); // overlay
    scene.register(grid, { ownerZ: 0, ownerId: 1 });
    scene.register(series, { ownerZ: 0, ownerId: 2 });
    scene.register(cross, { ownerZ: 0, ownerId: 3 });

    expect(tagsOf(scene.composite('base', FRAME))).toEqual(['grid', 'series']);
    expect(tagsOf(scene.composite('overlay', FRAME))).toEqual(['cross']);
  });

  test('an overlay composite re-emits ZERO base-band sources (§4.4.1)', () => {
    const scene = new PaneScene();
    const grid = new FakeSource('grid', ZBand.Grid);
    const cross = new FakeSource('cross', ZBand.Crosshair);
    scene.register(grid, { ownerZ: 0, ownerId: 1 });
    scene.register(cross, { ownerZ: 0, ownerId: 2 });
    scene.composite('base', FRAME); // seed base
    scene.composite('overlay', FRAME); // seed overlay

    grid.dirty(); // a base source is dirty, but an overlay composite must not touch it
    scene.composite('overlay', FRAME);
    expect(scene.sourcesReEmitted).toBe(0); // only overlay bands considered
    expect(grid.updates).toBe(1); // grid.update() NOT called by the overlay composite
  });
});

describe('PaneScene — within-band ordering (ownerZ, attachSeq)', () => {
  test('orders by ownerZ, then by attach sequence', () => {
    const scene = new PaneScene();
    const a = new FakeSource('a', ZBand.Series);
    const b = new FakeSource('b', ZBand.Series);
    const c = new FakeSource('c', ZBand.Series);
    // register out of z-order; expect (ownerZ, attachSeq) sort
    scene.register(c, { ownerZ: 5, ownerId: 3 });
    scene.register(a, { ownerZ: 1, ownerId: 1 });
    scene.register(b, { ownerZ: 1, ownerId: 2 }); // same ownerZ as a → attachSeq breaks tie
    expect(tagsOf(scene.composite('base', FRAME))).toEqual(['a', 'b', 'c']);
  });

  test('cross-band order always follows band index regardless of ownerZ', () => {
    const scene = new PaneScene();
    const series = new FakeSource('series', ZBand.Series); // band 3
    const grid = new FakeSource('grid', ZBand.Grid); // band 1
    scene.register(series, { ownerZ: 99, ownerId: 1 });
    scene.register(grid, { ownerZ: 0, ownerId: 2 });
    expect(tagsOf(scene.composite('base', FRAME))).toEqual(['grid', 'series']);
  });
});

describe('PaneScene — hovered-series-on-top reorder (study 01 §4.8)', () => {
  test('the hovered owner’s Series-band source is lifted last (drawn on top)', () => {
    const scene = new PaneScene();
    const s1 = new FakeSource('s1', ZBand.Series);
    const s2 = new FakeSource('s2', ZBand.Series);
    const s3 = new FakeSource('s3', ZBand.Series);
    scene.register(s1, { ownerZ: 0, ownerId: 10 });
    scene.register(s2, { ownerZ: 1, ownerId: 20 });
    scene.register(s3, { ownerZ: 2, ownerId: 30 });

    expect(tagsOf(scene.composite('base', FRAME))).toEqual(['s1', 's2', 's3']);

    scene.setHoveredOwner(10); // s1 hovered → moves to the top
    expect(tagsOf(scene.composite('base', FRAME))).toEqual(['s2', 's3', 's1']);

    scene.setHoveredOwner(null); // restore registration order
    expect(tagsOf(scene.composite('base', FRAME))).toEqual(['s1', 's2', 's3']);
  });

  test('the reorder lifts ONLY Series-band sources, never grid/crosshair', () => {
    const scene = new PaneScene();
    const grid = new FakeSource('grid', ZBand.Grid);
    const series = new FakeSource('series', ZBand.Series);
    const above = new FakeSource('above', ZBand.AboveSeries);
    scene.register(grid, { ownerZ: 0, ownerId: 1 });
    scene.register(series, { ownerZ: 0, ownerId: 1 }); // same owner as grid
    scene.register(above, { ownerZ: 0, ownerId: 1 });

    scene.setHoveredOwner(1);
    // grid (band 1) and above (band 4) keep their bands; only the Series-band entry
    // is subject to the lift — and with one Series source it stays put.
    expect(tagsOf(scene.composite('base', FRAME))).toEqual(['grid', 'series', 'above']);
  });
});

describe('PaneScene — registration lifecycle', () => {
  test('unregister removes a source from composition', () => {
    const scene = new PaneScene();
    const a = new FakeSource('a', ZBand.Series);
    const b = new FakeSource('b', ZBand.Series);
    scene.register(a, { ownerZ: 0, ownerId: 1 });
    scene.register(b, { ownerZ: 1, ownerId: 2 });
    expect(scene.size()).toBe(2);
    scene.unregister(a);
    expect(scene.size()).toBe(1);
    expect(tagsOf(scene.composite('base', FRAME))).toEqual(['b']);
  });
});
