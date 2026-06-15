// traderzview · extras/shared — the §12.4 plugin adapter convention. Every first-party
// factory (createSeriesMarkers/createUpDownMarkers/createTextWatermark/createImage-
// Watermark) wraps its IPrimitive in this one handle shape: { detach, applyOptions } +
// factory-specific methods. Built on PUBLIC seams only (the api IPrimitive + the
// series/pane attach surface + core's §5.1 mergeOptions); never model/views (arch §3.1).
// Spec: design 02 §12.4 / design 05 §2.2 (lifecycle) + §2.7.
import { mergeOptions, changedPaths } from '../../core';
import type { DeepPartial } from '../../core';
import type { IPrimitive } from '../../api';

/** The structural slice of an ISeries / IPane that the adapter attaches onto. Both
 *  public handles expose exactly this pair (design 02 §8/§11), so a plugin passes
 *  either one without the adapter importing the concrete facade types. */
export interface PrimitiveTarget {
  attachPrimitive(p: IPrimitive): void;
  detachPrimitive(p: IPrimitive): void;
}

/** The one adapter shape all four plugins return (design 02 §12.4): the lifecycle pair
 *  plus the factory-specific methods `M`. `O` is the plugin's resolved options type. */
export type PrimitiveAdapter<O, M = unknown> = {
  /** Tear down: unregister the primitive from its owner. Idempotent + exactly-once. */
  detach(): void;
  /** Standard §5.1 deep-merge over the current options; no-op-safe; forwards to onChange. */
  applyOptions(patch: DeepPartial<O>): void;
} & M;

/** Inputs to {@link createPrimitiveAdapter}. The plugin owns the primitive + its kept
 *  reference `defaults` and its already-resolved `options`; the adapter owns the attach
 *  call, the idempotent detach, and the §5.1 merge. */
export interface PrimitiveAdapterInit<O, M> {
  /** The owning handle (series or pane) — attached immediately on construction (§2.2). */
  target: PrimitiveTarget;
  /** The wrapped primitive — its identity is what attach/detach key on. */
  primitive: IPrimitive;
  /** The plugin's resolved current options (the single source of truth held here on). */
  options: O;
  /** The kept reference defaults — the reset target for leaf-null (§5.1 law 2). */
  defaults: O;
  /** Re-derive the plugin's state from the freshly-merged options. Called by
   *  applyOptions only when the merge actually changed the object (no-op patches skip). */
  onChange(next: O): void;
  /** The factory-specific methods (setMarkers/markers/setData/…) spread onto the handle. */
  methods: M;
  /** Optional extra teardown run inside the exactly-once detach, BEFORE detachPrimitive
   *  (e.g. an up-down-markers timer, a data-changed unsubscribe). */
  onDetach?(): void;
}

/**
 * Build the §12.4 adapter handle. On construction it attaches the primitive to its
 * owner once (the §2.2 attach lifecycle — the binding schedules the repaint). The
 * returned handle's `detach()` runs `onDetach` then `target.detachPrimitive(primitive)`
 * EXACTLY once (double-detach is a no-op, §2.2); `applyOptions(patch)` merges via the
 * standard §5.1 `mergeOptions` and, only if the merge produced a different object,
 * stores it and calls `onChange`. The plugin-specific `methods` are spread last.
 */
export function createPrimitiveAdapter<O, M = unknown>(
  init: PrimitiveAdapterInit<O, M>,
): PrimitiveAdapter<O, M> {
  let options = init.options;
  let detached = false;

  init.target.attachPrimitive(init.primitive);

  const handle = {
    ...init.methods,
    detach(): void {
      if (detached) return; // idempotent — exactly-once teardown (§2.2)
      detached = true;
      init.onDetach?.();
      init.target.detachPrimitive(init.primitive);
    },
    applyOptions(patch: DeepPartial<O>): void {
      const next = mergeOptions(options, patch, init.defaults);
      if (changedPaths(options, next).size === 0) return; // §5.1: unchanged patch is a no-op (no invalidation)
      options = next;
      init.onChange(next);
    },
  } as PrimitiveAdapter<O, M>;

  return handle;
}
