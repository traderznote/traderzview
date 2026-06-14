// The one binary-search primitive (study 10 §4.1, spec of record). A single
// count-halving body serves both bounds via the `lower` boolean; every sorted
// lookup in traderzview (plot rows by index, time points by key, tick marks,
// chunk boundaries, visible-range slicing) goes through lowerBound / upperBound.

function boundSearch<T, V>(
  arr: ArrayLike<T>,
  value: V,
  compare: (item: T, value: V) => boolean,
  lower: boolean,
  start: number,
  to: number,
): number {
  let count = to - start;
  while (count > 0) {
    const half = count >> 1;
    const mid = start + half;
    if (compare(arr[mid], value) === lower) {
      start = mid + 1;
      count -= half + 1;
    } else {
      count = half;
    }
  }
  return start;
}

/**
 * First index in `[start, to)` whose element is NOT `< value` — i.e. the insert
 * point that keeps `arr` sorted, landing on the first of any equal run.
 * `compare(item, value)` must return `item < value`.
 */
export function lowerBound<T, V>(
  arr: ArrayLike<T>,
  value: V,
  compare: (item: T, value: V) => boolean,
  start = 0,
  to: number = arr.length,
): number {
  return boundSearch(arr, value, compare, true, start, to);
}

/**
 * First index in `[start, to)` whose element IS `> value` — i.e. just past the
 * last of any equal run. `compare(item, value)` must return `item > value`.
 */
export function upperBound<T, V>(
  arr: ArrayLike<T>,
  value: V,
  compare: (item: T, value: V) => boolean,
  start = 0,
  to: number = arr.length,
): number {
  return boundSearch(arr, value, compare, false, start, to);
}
