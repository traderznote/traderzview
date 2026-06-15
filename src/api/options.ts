// traderzview · api — the options boundary (spec 02 §5–§6). The three-layer
// defaults pipeline (§5.2) and the FOUR boundary normalizations (§5.3) live here,
// applied at the API boundary ONLY — at creation AND in applyOptions:
//   1. handleScroll/handleScale boolean → object expansion (§5.3.1);
//   2. priceFormat.minMove without precision → precisionByMinMove, re-run on every
//      applyOptions carrying minMove (§5.3.2 — fixes the reference's creation-only
//      staleness);
//   3. candlestick borderColor/wickColor shorthands fan out via the definition's
//      normalizeOptions hook, then drop (§5.3.3 / §6.10);
//   4. timeScale.rightOffsetPixels px→bars (§5.3.4) — internally bar-denominated.
// Snapshot-out is a fresh deep copy, deep-FROZEN in dev (§4.3 / A5). null leaf =
// reset to default; deep-merge is the §5.1 mechanism (core mergeOptions).
import { mergeOptions } from '../core';
import type { DeepPartial, DeepReadonly } from '../core';
import { precisionByMinMove } from '../fmt';
import { rightOffsetFromPixels } from '../model';

// --- snapshots (§4.3 law: fresh deep copy on every options(); deep-frozen in dev) ---

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Structural deep clone: plain objects fresh (recursively); arrays, functions and
 *  class instances pass through by reference (§4.3 — never deep-copy a function). */
export function cloneOptions<T>(value: T): T {
  if (isPlainObject(value)) {
    const out: Rec = {};
    for (const k of Object.keys(value)) out[k] = cloneOptions((value as Rec)[k]);
    return out as T;
  }
  return value;
}

/** A fresh, immutable snapshot of `value` (§4.3). Every `options()` getter returns
 *  this — a deep copy so callers can never mutate stored state; recursively frozen
 *  in dev so an accidental write throws, a plain copy in prod (the freeze cost is
 *  dev-only). Arrays/functions/instances are shared by reference, not frozen. */
export function snapshot<T>(value: T): DeepReadonly<T> {
  const copy = cloneOptions(value);
  if (__DEV__) deepFreeze(copy);
  return copy as DeepReadonly<T>;
}

function deepFreeze(value: unknown): void {
  if (!isPlainObject(value)) return;
  for (const k of Object.keys(value)) deepFreeze(value[k]);
  Object.freeze(value);
}

// --- normalization 1: handleScroll / handleScale boolean → object (§5.3.1) ---------

/** The four scroll flags a `handleScroll: true|false` expands to (§6.8). */
export interface HandleScrollOptions {
  mouseWheel: boolean;
  pressedMouseMove: boolean;
  horzTouchDrag: boolean;
  vertTouchDrag: boolean;
}

/** The scale flags a `handleScale: true|false` expands to; the two axis members are
 *  themselves `{ time, price }` objects, and a boolean there expands too (§6.8). */
export interface HandleScaleOptions {
  mouseWheel: boolean;
  pinch: boolean;
  axisPressedMouseMove: { time: boolean; price: boolean };
  axisDoubleClickReset: { time: boolean; price: boolean };
}

function scrollAll(on: boolean): HandleScrollOptions {
  return { mouseWheel: on, pressedMouseMove: on, horzTouchDrag: on, vertTouchDrag: on };
}

function scaleAll(on: boolean): HandleScaleOptions {
  return {
    mouseWheel: on,
    pinch: on,
    axisPressedMouseMove: { time: on, price: on },
    axisDoubleClickReset: { time: on, price: on },
  };
}

/** Expand a `handleScroll` value to its full object (§5.3.1). A bare boolean fans out
 *  to all four flags; a partial object is left as-is (the §5.1 merge fills the rest). */
export function normalizeHandleScroll(value: unknown): unknown {
  return typeof value === 'boolean' ? scrollAll(value) : value;
}

/** Expand a `handleScale` value to its full object (§5.3.1). A bare boolean fans out
 *  to every flag (incl. both `{ time, price }` axis members); within a partial
 *  object, a boolean `axisPressedMouseMove`/`axisDoubleClickReset` expands to
 *  `{ time, price }`, while object members pass through to the §5.1 merge. */
export function normalizeHandleScale(value: unknown): unknown {
  if (typeof value === 'boolean') return scaleAll(value);
  if (!isPlainObject(value)) return value;
  const out: Rec = { ...value };
  for (const axis of ['axisPressedMouseMove', 'axisDoubleClickReset'] as const) {
    const v = out[axis];
    if (typeof v === 'boolean') out[axis] = { time: v, price: v };
  }
  return out;
}

// --- normalization 4: timeScale.rightOffsetPixels px → bars (§5.3.4) ---------------

/** Convert `timeScale.rightOffsetPixels` (if set) to a bar offset and write it onto
 *  `rightOffset`, then drop the pixel key — internally the offset is always
 *  bar-denominated (§5.3.4). A configured `0` (or unset) behaves as if unset: the
 *  reference truthiness rule, kept and documented — px wins only when truthy.
 *  `barSpacing` is the spacing at the moment of application (offset = px / S).
 *  Mutates and returns the supplied timeScale patch object. */
export function normalizeRightOffsetPixels(timeScale: Rec, barSpacing: number): Rec {
  const px = timeScale.rightOffsetPixels;
  if (typeof px === 'number' && px !== 0 && barSpacing > 0) {
    timeScale.rightOffset = rightOffsetFromPixels(px, barSpacing);
  }
  delete timeScale.rightOffsetPixels;
  return timeScale;
}

/** Apply the two TOP-LEVEL chart normalizations (§5.3.1 + §5.3.4) to a chart patch,
 *  in place, returning a NEW patch object (the input is never mutated, so a frozen
 *  user partial is safe). `barSpacing` is the spacing px→bars resolves against. */
export function normalizeChartPatch<T extends Rec>(patch: T, barSpacing: number): T {
  const out: Rec = { ...patch };
  if ('handleScroll' in out) out.handleScroll = normalizeHandleScroll(out.handleScroll);
  if ('handleScale' in out) out.handleScale = normalizeHandleScale(out.handleScale);
  if (isPlainObject(out.timeScale)) {
    out.timeScale = normalizeRightOffsetPixels({ ...out.timeScale }, barSpacing);
  }
  return out as T;
}

// --- normalizations 2 + 3: series patch (precision + candlestick shorthand) --------

/** A series definition's shorthand-expansion hook (spec 02 §13.2): the candlestick
 *  definition wires `candlestickNormalizeOptions` here; most definitions omit it. */
export type NormalizeOptionsHook = (patch: Rec) => void;

/** Re-run minMove→precision (§5.3.2). When a `priceFormat` patch carries `minMove`
 *  but no explicit `precision`, derive `precision = precisionByMinMove(minMove)`.
 *  Runs at creation AND on EVERY applyOptions carrying minMove — fixing the
 *  reference's creation-only staleness (§5.3.2). Mutates the priceFormat patch. */
export function normalizePriceFormat(priceFormat: Rec): Rec {
  if (typeof priceFormat.minMove === 'number' && priceFormat.precision === undefined) {
    priceFormat.precision = precisionByMinMove(priceFormat.minMove);
  }
  return priceFormat;
}

/** Apply the two SERIES normalizations (§5.3.2 + §5.3.3) to a series-options patch,
 *  in place, returning a NEW patch object (input never mutated). The definition's
 *  optional `normalizeOptions` hook fans out the candlestick `borderColor`/`wickColor`
 *  write-only shorthands to up/down variants and DROPS them (they are never stored;
 *  `options()` never returns them, unlike the reference's stale aggregates). */
export function normalizeSeriesPatch<T extends Rec>(patch: T, hook?: NormalizeOptionsHook): T {
  const out: Rec = { ...patch };
  if (isPlainObject(out.priceFormat)) out.priceFormat = normalizePriceFormat({ ...out.priceFormat });
  if (hook) hook(out);
  return out as T;
}

// --- the three-layer defaults pipeline (§5.2) --------------------------------------

/** A behavior's defaults augmentation — layer 2 of the pipeline (§5.2). The behavior
 *  mutates a cloned strict-defaults object in place; only `timeScale`/`localization`
 *  are reachable (the `HorzScaleOptionGroups` shape). Typed loosely here so this file
 *  carries no `data`/`model` value import beyond px→bars. */
export type AugmentDefaults<G> = (groups: G) => void;

/**
 * Build the layer-1+2 EFFECTIVE defaults for a chart (§5.2): clone the library
 * defaults, then let the behavior augment its two option groups in place. This is
 * the reset target every leaf-null in a later patch resets to (§5.1) — so the
 * augmented `localization.dateFormat` is what a `localization.dateFormat: null`
 * restores, not the bare library default. Returns a fresh object; inputs untouched.
 */
export function effectiveDefaults<T extends object, G>(
  libraryDefaults: T,
  augment: AugmentDefaults<G> | undefined,
): T {
  const defaults = cloneOptions(libraryDefaults);
  if (augment) augment(defaults as unknown as G);
  return defaults;
}

/**
 * The full creation pipeline for chart options (§5.2 + the §5.3 chart normalizations):
 *   effective = merge(effectiveDefaults(libraryDefaults, augment), normalize(userPatch))
 * The user patch is normalized (handleScroll/handleScale, rightOffsetPixels px→bars)
 * BEFORE the merge, against `barSpacing` (the spacing px resolves against at apply
 * time — pass the effective barSpacing). Returns the stored object; never aliases the
 * user partial (the merge clones at the boundary, §5.1).
 */
export function createChartOptions<T extends object, G>(
  libraryDefaults: T,
  augment: AugmentDefaults<G> | undefined,
  userPatch: DeepPartial<T> | undefined,
  barSpacing: number,
): T {
  const defaults = effectiveDefaults(libraryDefaults, augment);
  if (userPatch === undefined) return defaults;
  const normalized = normalizeChartPatch(userPatch as Rec, barSpacing);
  return mergeOptions(defaults, normalized as DeepPartial<T>, defaults);
}

/**
 * Re-merge a chart-options patch over the stored object in applyOptions (§5.1 + the
 * §5.3 chart normalizations re-run). `defaults` is the leaf-null reset target (the
 * SAME effective defaults from creation — keep it around). `barSpacing` is the live
 * spacing px→bars resolves against now. Returns the new stored object.
 */
export function applyChartOptions<T extends object>(
  stored: T,
  defaults: T,
  patch: DeepPartial<T>,
  barSpacing: number,
): T {
  const normalized = normalizeChartPatch(patch as Rec, barSpacing);
  return mergeOptions(stored, normalized as DeepPartial<T>, defaults);
}

/**
 * The creation pipeline for one series' options (§5.2 + the §5.3 series
 * normalizations). `libraryDefaults` is the definition's style defaults already
 * merged with `SeriesOptionsCommon` (§8.1 / §13.2). The user patch is normalized
 * (minMove→precision, candlestick shorthand via `hook`) before the merge.
 */
export function createSeriesOptions<T extends object>(
  libraryDefaults: T,
  userPatch: DeepPartial<T> | undefined,
  hook?: NormalizeOptionsHook,
): T {
  const defaults = cloneOptions(libraryDefaults);
  if (userPatch === undefined) return defaults;
  const normalized = normalizeSeriesPatch(userPatch as Rec, hook);
  return mergeOptions(defaults, normalized as DeepPartial<T>, defaults);
}

/**
 * Re-merge a series-options patch over the stored object in applyOptions (§5.1 + the
 * §5.3 series normalizations re-run — both minMove→precision AND the candlestick
 * shorthand expansion run here, deliberately wiring the reference's dead applyOptions
 * path, §5.3.3). `defaults` is the leaf-null reset target.
 */
export function applySeriesOptions<T extends object>(
  stored: T,
  defaults: T,
  patch: DeepPartial<T>,
  hook?: NormalizeOptionsHook,
): T {
  const normalized = normalizeSeriesPatch(patch as Rec, hook);
  return mergeOptions(stored, normalized as DeepPartial<T>, defaults);
}
