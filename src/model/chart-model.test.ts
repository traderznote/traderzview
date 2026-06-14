import { describe, expect, test } from 'vitest';
import {
  ChartModel,
  UpdateLevel,
  createMask,
  emptyMask,
  invalidationLevelForPaths,
  mergeMasks,
} from './chart-model';
import { timeBehavior } from '../data';
import { formatPaneId } from './shared';

const P0 = formatPaneId(0);
const P1 = formatPaneId(1);

describe('UpdateLevel', () => {
  test('is a const-object union (None<Overlay<Render<Layout), not an enum', () => {
    expect(UpdateLevel.None).toBe(0);
    expect(UpdateLevel.Overlay).toBe(1);
    expect(UpdateLevel.Render).toBe(2);
    expect(UpdateLevel.Layout).toBe(3);
  });
});

describe('UpdateMask invariants (architecture §4.4, dev-asserted)', () => {
  test('None ⇒ both sets empty (allowed)', () => {
    const m = createMask({ level: UpdateLevel.None });
    expect(m.level).toBe(UpdateLevel.None);
    expect(m.autoscalePanes.size).toBe(0);
    expect(m.horzCommands.length).toBe(0);
  });

  test('None with a non-empty autoscale set throws (dev assert)', () => {
    expect(() =>
      createMask({ level: UpdateLevel.None, autoscalePanes: new Set([P0]) }),
    ).toThrow();
  });

  test('None with a queued horz command throws (dev assert)', () => {
    expect(() =>
      createMask({ level: UpdateLevel.None, horzCommands: [{ kind: 'fitContent' }] }),
    ).toThrow();
  });

  test('queuing autoscale at Overlay throws — requires ≥ Render', () => {
    expect(() =>
      createMask({ level: UpdateLevel.Overlay, autoscalePanes: new Set([P0]) }),
    ).toThrow();
  });

  test('queuing a horz command at Overlay throws — requires ≥ Render', () => {
    expect(() =>
      createMask({ level: UpdateLevel.Overlay, horzCommands: [{ kind: 'reset' }] }),
    ).toThrow();
  });

  test('Render with an autoscale pane and a queued command is valid', () => {
    const m = createMask({
      level: UpdateLevel.Render,
      autoscalePanes: new Set([P0]),
      horzCommands: [{ kind: 'setBarSpacing', value: 8 }],
    });
    expect(m.autoscalePanes.has(P0)).toBe(true);
    expect(m.horzCommands.length).toBe(1);
  });
});

describe('mergeMasks is monotone (architecture §4.4)', () => {
  test('level = max', () => {
    const a = createMask({ level: UpdateLevel.Overlay });
    const b = createMask({ level: UpdateLevel.Layout });
    expect(mergeMasks(a, b).level).toBe(UpdateLevel.Layout);
    expect(mergeMasks(b, a).level).toBe(UpdateLevel.Layout);
  });

  test('autoscalePanes = union', () => {
    const a = createMask({ level: UpdateLevel.Render, autoscalePanes: new Set([P0]) });
    const b = createMask({ level: UpdateLevel.Render, autoscalePanes: new Set([P1]) });
    const m = mergeMasks(a, b);
    expect(m.autoscalePanes.has(P0)).toBe(true);
    expect(m.autoscalePanes.has(P1)).toBe(true);
    expect(m.autoscalePanes.size).toBe(2);
  });

  test('horzCommands replayed through reduceHorzCommands (replace law preserved)', () => {
    const a = createMask({
      level: UpdateLevel.Render,
      horzCommands: [{ kind: 'setBarSpacing', value: 8 }],
    });
    const b = createMask({ level: UpdateLevel.Render, horzCommands: [{ kind: 'fitContent' }] });
    // fitContent REPLACES the queue when replayed into a.
    const m = mergeMasks(a, b);
    expect(m.horzCommands).toEqual([{ kind: 'fitContent' }]);
  });

  test('stopAnimation merged into a pending animate cancels it (subtle study 01 §4.2 law)', () => {
    const anim = { finished: () => false, positionAt: () => 0 };
    const a = createMask({
      level: UpdateLevel.Render,
      horzCommands: [{ kind: 'animate', animation: anim }],
    });
    const b = createMask({ level: UpdateLevel.Render, horzCommands: [{ kind: 'stopAnimation' }] });
    const m = mergeMasks(a, b);
    // the animate is gone; only the surviving stop token remains.
    expect(m.horzCommands.some((c) => c.kind === 'animate')).toBe(false);
    expect(m.horzCommands).toEqual([{ kind: 'stopAnimation' }]);
  });

  test('merging two valid masks yields a valid mask (None+None stays empty)', () => {
    const m = mergeMasks(emptyMask(), emptyMask());
    expect(m.level).toBe(UpdateLevel.None);
    expect(m.autoscalePanes.size).toBe(0);
    expect(m.horzCommands.length).toBe(0);
  });
});

describe('option-path → invalidation-level table (architecture §4.3)', () => {
  test('layout/size paths map to Layout', () => {
    expect(invalidationLevelForPaths(new Set(['width']))).toBe(UpdateLevel.Layout);
    expect(invalidationLevelForPaths(new Set(['layout.fontSize']))).toBe(UpdateLevel.Layout);
  });

  test('crosshair paths map to Overlay', () => {
    expect(invalidationLevelForPaths(new Set(['crosshair.mode']))).toBe(UpdateLevel.Overlay);
  });

  test('grid paths map to Render', () => {
    expect(invalidationLevelForPaths(new Set(['grid.vertLines.color']))).toBe(UpdateLevel.Render);
  });

  test('the union takes the MAX level across all fired paths', () => {
    expect(invalidationLevelForPaths(new Set(['crosshair.mode', 'width']))).toBe(UpdateLevel.Layout);
  });

  test('an empty / unknown path set maps to None', () => {
    expect(invalidationLevelForPaths(new Set())).toBe(UpdateLevel.None);
    expect(invalidationLevelForPaths(new Set(['unknown.path']))).toBe(UpdateLevel.None);
  });
});

describe('ChartModel registry + invalidation callback (architecture §4.3)', () => {
  test('starts with one default pane (addDefaultPane true)', () => {
    const m = new ChartModel({ behavior: timeBehavior(), invalidate: () => {} });
    expect(m.panes().panes().length).toBe(1);
  });

  test('addDefaultPane:false starts empty', () => {
    const m = new ChartModel({
      behavior: timeBehavior(),
      invalidate: () => {},
      options: { addDefaultPane: false },
    });
    expect(m.panes().panes().length).toBe(0);
  });

  test('applyOptions fires ONE mask through the injected callback at the mapped level', () => {
    const masks: UpdateLevel[] = [];
    const m = new ChartModel({
      behavior: timeBehavior(),
      invalidate: (mask) => masks.push(mask.level),
    });
    m.applyOptions({ crosshair: { mode: 'normal' } });
    expect(masks).toEqual([UpdateLevel.Overlay]);
    m.applyOptions({ width: 800, height: 600 });
    expect(masks[1]).toBe(UpdateLevel.Layout);
  });

  test('applyOptions with no actual change fires nothing (None is not dispatched)', () => {
    const masks: UpdateLevel[] = [];
    const m = new ChartModel({
      behavior: timeBehavior(),
      invalidate: (mask) => masks.push(mask.level),
    });
    m.applyOptions({ crosshair: { mode: 'magnet' } }); // already the default
    expect(masks).toEqual([]);
  });

  test('options() returns a snapshot, never the live object (architecture §4.3)', () => {
    const m = new ChartModel({ behavior: timeBehavior(), invalidate: () => {} });
    const a = m.options();
    const b = m.options();
    expect(a).not.toBe(b);
    expect(a).toEqual(b);
  });

  test('queueHorzCommand assembles a Render mask carrying the command', () => {
    let last: { level: UpdateLevel; horz: number } | null = null;
    const m = new ChartModel({
      behavior: timeBehavior(),
      invalidate: (mask) => {
        last = { level: mask.level, horz: mask.horzCommands.length };
      },
    });
    m.queueHorzCommand({ kind: 'fitContent' });
    expect(last).not.toBeNull();
    expect(last!.level).toBe(UpdateLevel.Render);
    expect(last!.horz).toBe(1);
  });

  test('invalidateAutoscale assembles a Render mask carrying the pane', () => {
    let last: { level: UpdateLevel; panes: number } | null = null;
    const m = new ChartModel({
      behavior: timeBehavior(),
      invalidate: (mask) => {
        last = { level: mask.level, panes: mask.autoscalePanes.size };
      },
    });
    const id = m.panes().panes()[0].id();
    m.invalidateAutoscale(id);
    expect(last!.level).toBe(UpdateLevel.Render);
    expect(last!.panes).toBe(1);
  });
});
