// The chart-model registry (architecture §4.6 chart-model row; §4.3 options
// ownership + option-path→invalidation tables; §4.4 UpdateLevel/UpdateMask +
// invariants + mask-merge monotonicity; study 01 §4 is the spec of record).
//
// This is the model's source-of-truth registry: it owns the panes (via
// `PaneManager`), the chart-level options, the ONE injected invalidation callback,
// and `UpdateMask` ASSEMBLY. The host's frame scheduler consumes the masks; the
// model never schedules a frame itself (architecture §4.4 — "model mask, host
// scheduler"). It imports only core / fmt / data / sibling model (architecture §3.1).
import { assert, changedPaths, mergeOptions, type DeepPartial } from '../core';
import type { IHorzScaleBehavior } from '../data';
import { PaneManager } from './pane-manager';
import { reduceHorzCommands, type HorzScaleCommand } from './time-scale/navigator';
import {
  DEFAULT_CHART_OPTIONS,
  type ChartOptions,
  type PaneId,
} from './shared';

// ---------------------------------------------------------------------------
// UpdateLevel — a CONST-OBJECT union, NOT an enum (erasableSyntaxOnly, M0). The
// reference's four levels, renamed to state intent (architecture §4.4):
//   Overlay: repaint overlay layers only (crosshair, hover, cursor primitives)
//   Render:  recompute autoscale + repaint base layers; no DOM/layout work
//   Layout:  re-sync widget tree, re-measure axes, resize surfaces, then Render
// ---------------------------------------------------------------------------

export const UpdateLevel = {
  None: 0,
  Overlay: 1,
  Render: 2,
  Layout: 3,
} as const;
export type UpdateLevel = (typeof UpdateLevel)[keyof typeof UpdateLevel];

// ---------------------------------------------------------------------------
// UpdateMask — the model's single invalidation value (architecture §4.4). The
// reference's per-pane levels are deleted (study 10 §3.1: every producer set global
// ≥ pane; the map only ever transported autoScale). What remains:
//   level           : the global update level
//   autoscalePanes  : panes needing a one-shot momentary autoscale
//   horzCommands    : queued time-scale commands (the closed algebra)
// ---------------------------------------------------------------------------

export interface UpdateMask {
  readonly level: UpdateLevel;
  readonly autoscalePanes: ReadonlySet<PaneId>;
  readonly horzCommands: readonly HorzScaleCommand[];
}

export interface MaskInit {
  level: UpdateLevel;
  autoscalePanes?: ReadonlySet<PaneId>;
  horzCommands?: readonly HorzScaleCommand[];
}

const EMPTY_PANES: ReadonlySet<PaneId> = new Set();
const NO_COMMANDS: readonly HorzScaleCommand[] = [];

/**
 * Construct a validated `UpdateMask` (architecture §4.4). The invariants are
 * DEV-ASSERTED here so producers cannot get them wrong silently:
 *   • level === None  ⇒  both sets empty;
 *   • queuing ANY horz command or autoscale pane requires level ≥ Render
 *     (an Overlay mask never carries either).
 */
export function createMask(init: MaskInit): UpdateMask {
  const autoscalePanes = init.autoscalePanes ?? EMPTY_PANES;
  const horzCommands = init.horzCommands ?? NO_COMMANDS;
  const hasWork = autoscalePanes.size > 0 || horzCommands.length > 0;

  assert(
    !(init.level === UpdateLevel.None && hasWork),
    'UpdateMask: level=None must carry no autoscale panes or horz commands (architecture §4.4)',
  );
  assert(
    !(init.level < UpdateLevel.Render && hasWork),
    'UpdateMask: queuing an autoscale pane or horz command requires level ≥ Render (architecture §4.4)',
  );

  return {
    level: init.level,
    autoscalePanes,
    horzCommands,
  };
}

/** The neutral mask (level None, both sets empty). */
export function emptyMask(): UpdateMask {
  return createMask({ level: UpdateLevel.None });
}

/**
 * Merge two valid masks into a valid mask — MONOTONE (architecture §4.4):
 *   • level          = max(a, b);
 *   • autoscalePanes = union;
 *   • horzCommands   = b's queue REPLAYED into a's through `reduceHorzCommands`
 *     (so the replace/append/cancel laws — including stopAnimation cancelling a
 *     pending animate in the destination — hold across a merge, study 01 §4.2).
 */
export function mergeMasks(a: UpdateMask, b: UpdateMask): UpdateMask {
  const level = Math.max(a.level, b.level) as UpdateLevel;

  let autoscalePanes: ReadonlySet<PaneId>;
  if (b.autoscalePanes.size === 0) {
    autoscalePanes = a.autoscalePanes;
  } else if (a.autoscalePanes.size === 0) {
    autoscalePanes = b.autoscalePanes;
  } else {
    const union = new Set<PaneId>(a.autoscalePanes);
    for (const p of b.autoscalePanes) union.add(p);
    autoscalePanes = union;
  }

  let horzCommands = a.horzCommands;
  for (const cmd of b.horzCommands) horzCommands = reduceHorzCommands(horzCommands, cmd);

  return createMask({ level, autoscalePanes, horzCommands });
}

// ---------------------------------------------------------------------------
// Option-path → invalidation-level table (architecture §4.3). Subsystems declare
// the mapping rather than hand-writing if-chains; the union of fired changed-paths
// maps to ONE level (the MAX). A path matches the most specific table prefix.
// ---------------------------------------------------------------------------

interface PathRule {
  readonly prefix: string;
  readonly level: UpdateLevel;
}

// Ordered most-specific-first; the first matching prefix wins.
const PATH_RULES: readonly PathRule[] = [
  // size / layout / typography → re-sync widgets, re-measure axes (Layout).
  { prefix: 'width', level: UpdateLevel.Layout },
  { prefix: 'height', level: UpdateLevel.Layout },
  { prefix: 'autoSize', level: UpdateLevel.Layout },
  { prefix: 'layout', level: UpdateLevel.Layout },
  // crosshair → overlay-only repaint.
  { prefix: 'crosshair', level: UpdateLevel.Overlay },
  // grid / background-of-record → base-layer repaint (Render).
  { prefix: 'grid', level: UpdateLevel.Render },
  { prefix: 'hoveredSeriesOnTop', level: UpdateLevel.Render },
];

function levelForPath(path: string): UpdateLevel {
  for (const rule of PATH_RULES) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) return rule.level;
  }
  return UpdateLevel.None;
}

/** The MAX invalidation level over a set of fired changed-paths (architecture §4.3).
 *  An empty set, or one of only unknown paths, maps to None. */
export function invalidationLevelForPaths(paths: ReadonlySet<string>): UpdateLevel {
  let level: UpdateLevel = UpdateLevel.None;
  for (const path of paths) {
    const l = levelForPath(path);
    if (l > level) level = l;
  }
  return level;
}

// ---------------------------------------------------------------------------
// ChartModel
// ---------------------------------------------------------------------------

/** The one injected invalidation callback (architecture §4.3/§4.4): the model
 *  hands the host ONE assembled mask; the host coalesces + schedules. */
export type InvalidateCallback = (mask: UpdateMask) => void;

export interface ChartModelInit<H = unknown, I = unknown> {
  readonly behavior: IHorzScaleBehavior<H, I>;
  readonly invalidate: InvalidateCallback;
  readonly options?: DeepPartial<ChartOptions>;
}

export class ChartModel<H = unknown, I = unknown> {
  readonly #behavior: IHorzScaleBehavior<H, I>;
  readonly #invalidate: InvalidateCallback;
  readonly #panes = new PaneManager();
  #options: ChartOptions;

  constructor(init: ChartModelInit<H, I>) {
    this.#behavior = init.behavior;
    this.#invalidate = init.invalidate;
    this.#options = mergeOptions(
      DEFAULT_CHART_OPTIONS,
      init.options ?? {},
      DEFAULT_CHART_OPTIONS,
    );
    if (this.#options.addDefaultPane) this.#panes.addPane();
  }

  /** The horizontal-scale behavior (the time behavior in core charts). */
  behavior(): IHorzScaleBehavior<H, I> {
    return this.#behavior;
  }

  /** The pane registry (panes / scales / series membership). */
  panes(): PaneManager {
    return this.#panes;
  }

  /** A snapshot of the merged chart options — never the live object (§4.3). */
  options(): ChartOptions {
    return structuredCloneOptions(this.#options);
  }

  /**
   * Apply a chart-options patch through the ONE path (architecture §4.3):
   * merge → changed-path set → map the union to ONE level → fire ONE mask. A patch
   * that changes nothing fires nothing (None is never dispatched).
   */
  applyOptions(patch: DeepPartial<ChartOptions>): void {
    const before = this.#options;
    const after = mergeOptions(before, patch, DEFAULT_CHART_OPTIONS);
    const paths = changedPaths(before, after);
    this.#options = after;
    const level = invalidationLevelForPaths(paths);
    if (level !== UpdateLevel.None) this.#invalidate(createMask({ level }));
  }

  /** Queue a time-scale command (architecture §4.4): fires a Render mask carrying
   *  the single command (the reducer collapses a burst when the host merges masks). */
  queueHorzCommand(command: HorzScaleCommand): void {
    this.#invalidate(
      createMask({ level: UpdateLevel.Render, horzCommands: [command] }),
    );
  }

  /** Request a one-shot momentary autoscale for a pane (architecture §4.4): fires a
   *  Render mask carrying that pane id. */
  invalidateAutoscale(paneId: PaneId): void {
    this.#invalidate(
      createMask({ level: UpdateLevel.Render, autoscalePanes: new Set([paneId]) }),
    );
  }

  /** Fire a bare level invalidation (e.g. a data diff producing a Render frame). */
  invalidate(level: UpdateLevel): void {
    if (level !== UpdateLevel.None) this.#invalidate(createMask({ level }));
  }
}

/** Deep-clone the chart options for a snapshot (the merge produced fresh leaves,
 *  but `options()` must not alias the live object's nested groups; architecture
 *  §4.3). Plain-data only, so a structural clone is exact and cheap. */
function structuredCloneOptions(o: ChartOptions): ChartOptions {
  return {
    ...o,
    layout: { ...o.layout, background: { ...o.layout.background } },
    grid: {
      vertLines: { ...o.grid.vertLines },
      horzLines: { ...o.grid.horzLines },
    },
    crosshair: { ...o.crosshair },
  };
}
