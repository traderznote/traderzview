// The options mechanism (architecture §4.3). One total, principled deep-merge is
// the single path every options group flows through; ownership (who holds the
// merged object, who may read a snapshot) lives in api/model, not here.

/**
 * A patch over `T`: every key optional and recursively partial. Arrays,
 * functions, and class instances are replaced wholesale (never deep-merged).
 * `null` is admitted only at primitive leaves — it means "reset to default"
 * (§4.3 law 2); resetting a whole sub-object is deliberately untypeable.
 */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends (...args: never[]) => unknown
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K] | null;
};

/** A deeply-immutable view of `T` — what every `options()` accessor returns. */
export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/**
 * Structural clone: plain objects become fresh objects (recursively); arrays,
 * functions, and class instances pass through by reference; primitives by value.
 * This is what keeps merge results from aliasing the trusted base/defaults graph.
 */
function clonePlain<T>(value: T): T {
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) out[k] = clonePlain(value[k]);
    return out as T;
  }
  return value;
}

function mergeInto(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(base)) out[k] = clonePlain(base[k]); // structural copy of base

  for (const k of Object.keys(patch)) {
    if (POLLUTION_KEYS.has(k)) {
      throw new Error(`mergeOptions: refusing prototype-pollution key "${k}"`); // law 5
    }
    const pv = patch[k];
    if (pv === undefined) continue; // law 1: ignore
    if (pv === null) {
      out[k] = clonePlain(defaults[k]); // law 2: leaf reset to default
      continue;
    }
    if (isPlainObject(pv)) {
      // law 3 (recurse) + law 6 (clone, never alias the user's nested object)
      const bv = isPlainObject(base[k]) ? base[k] : {};
      const dv = isPlainObject(defaults[k]) ? defaults[k] : {};
      out[k] = mergeInto(bv, pv, dv);
    } else {
      out[k] = pv; // law 4: arrays/functions/instances by reference; primitives by value
    }
  }
  return out;
}

/**
 * Merge `patch` over `base` and return a NEW object; never mutates any input
 * (safe on frozen base/patch/defaults). `defaults` is the reset target for the
 * leaf-null law. Obeys the six merge laws of architecture §4.3.
 */
export function mergeOptions<T>(base: T, patch: DeepPartial<T>, defaults: T): T {
  return mergeInto(
    base as Record<string, unknown>,
    patch as Record<string, unknown>,
    defaults as Record<string, unknown>,
  ) as T;
}

function diff(before: unknown, after: unknown, prefix: string, out: Set<string>): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diff(before[k], after[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (!Object.is(before, after)) out.add(prefix);
}

/**
 * The dot-paths of leaves whose value actually changed between two option
 * snapshots — the input subsystems map to one invalidation mask (§4.3). Arrays,
 * functions, and instances compare by reference (a new reference counts as a change).
 */
export function changedPaths(before: unknown, after: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  diff(before, after, '', out);
  return out;
}
