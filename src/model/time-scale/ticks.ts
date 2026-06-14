// The TickMarkEngine (architecture §4.6; study 03 §4.11 selection / §4.12 density
// are the spec of record). Tick-mark WEIGHT ASSIGNMENT is the behavior's job and
// already lives in `data` (Timeline holds per-slot weights from behavior.fillWeights);
// this engine owns only:
//   • tick-mark SELECTION by descending weight with the weight-merge rule — keep a
//     lower-weight mark only when it is ≥ maxIndexesPerMark from its accepted
//     neighbors on both sides (study 03 §4.11);
//   • the all-or-nothing `uniformDistribution` option;
//   • tick density math (study 03 §4.12);
//   • a one-entry selection cache keyed by (maxIndexesPerMark, whitespace-set id,
//     whitespace flag) — the key IGNORES scroll, so panning at a stable zoom never
//     rebuilds (study 03 §4.11/§4.13).

/** One tick-mark candidate. `index` is the union TimeIndex; `weight` is the
 *  behavior-assigned significance (year > month > day > …). Callers may carry
 *  extra fields (time/originalTime/label) — they round-trip untouched. */
export interface TickMark {
  readonly index: number;
  readonly weight: number;
}

/** Inputs to one selection pass. The engine never sees scroll/right-offset — that
 *  is what makes the cache key scroll-independent (study 03 §4.11). */
export interface BuildParams<M extends TickMark = TickMark> {
  /** Minimum index distance between two kept labels (study 03 §4.11). */
  readonly maxIndexesPerMark: number;
  /** All-or-nothing: a weight level is drawn only if EVERY one of its marks fits. */
  readonly uniformDistribution?: boolean;
  /** "has data at that index" — false ⇒ the mark is never selected. Default: all
   *  includable (ignoreWhitespaceIndices off). */
  readonly includable?: (mark: M) => boolean;
  /** ignoreWhitespaceIndices flag — part of the cache key (study 03 §4.11). */
  readonly whitespaceFlag?: boolean;
  /** Monotonic id of the indices-with-data set — part of the cache key; bump it
   *  when the whitespace set changes so a stale selection is not reused. */
  readonly whitespaceSetId?: number;
}

// --- density math (study 03 §4.12) ----------------------------------------------

const DEFAULT_TICK_MAX_CHARS = 8;

/** maxLabelWidth = ((fontSize + 4)·5 / 8) · (tickMarkMaxCharacterLength or 8)
 *  (study 03 §4.12: pixelsPer8Chars = (fontSize+4)·5, perChar = /8). */
export function maxLabelWidthFor(fontSize: number, maxChars: number | undefined): number {
  const pixelsPerChar = ((fontSize + 4) * 5) / 8;
  return pixelsPerChar * (maxChars ?? DEFAULT_TICK_MAX_CHARS);
}

/** The min index distance so two labels cannot overlap: ceil(maxLabelWidth / S). */
export function maxIndexesPerMark(maxLabelWidth: number, barSpacing: number): number {
  return Math.ceil(maxLabelWidth / barSpacing);
}

/** Label density used by `marks()` window math: round(maxLabelWidth / S) (§4.12). */
export function indexPerLabel(maxLabelWidth: number, barSpacing: number): number {
  return Math.round(maxLabelWidth / barSpacing);
}

// --- the engine -----------------------------------------------------------------

interface CacheEntry<M extends TickMark> {
  readonly maxIndexesPerMark: number;
  readonly uniform: boolean;
  readonly whitespaceFlag: boolean;
  readonly whitespaceSetId: number;
  readonly result: readonly M[];
}

export class TickMarkEngine<M extends TickMark = TickMark> {
  /** marksByWeight: weight → index-ascending marks (study 03 §4.11). */
  #byWeight = new Map<number, M[]>();
  /** Weights present, DESCENDING (the selection processing order). */
  #weightsDesc: number[] = [];
  /** The one-entry selection cache. */
  #cache: CacheEntry<M> | null = null;

  /**
   * Install the full mark set (index-ascending or not — bucketed here). Clears
   * the selection cache. (The reference maintains the buckets incrementally with
   * a firstChanged truncate-and-refill; the data layer already owns the
   * incremental weight fill, so the engine simply re-buckets on update.)
   */
  setMarks(marks: readonly M[]): void {
    const byWeight = new Map<number, M[]>();
    for (const m of marks) {
      let bucket = byWeight.get(m.weight);
      if (bucket === undefined) {
        bucket = [];
        byWeight.set(m.weight, bucket);
      }
      bucket.push(m);
    }
    // each per-weight list must be index-ascending for the merge walk.
    for (const bucket of byWeight.values()) bucket.sort((a, b) => a.index - b.index);
    this.#byWeight = byWeight;
    this.#weightsDesc = [...byWeight.keys()].sort((a, b) => b - a);
    this.#cache = null;
  }

  /**
   * Select the non-overlapping tick marks (study 03 §4.11). Returns an index-
   * ascending array. Served from the one-entry cache when the key matches — the
   * key is (maxIndexesPerMark, uniform, whitespaceFlag, whitespaceSetId) and
   * deliberately IGNORES scroll.
   */
  build(params: BuildParams<M>): readonly M[] {
    const uniform = params.uniformDistribution ?? false;
    const whitespaceFlag = params.whitespaceFlag ?? false;
    const whitespaceSetId = params.whitespaceSetId ?? 0;

    const c = this.#cache;
    if (
      c !== null &&
      c.maxIndexesPerMark === params.maxIndexesPerMark &&
      c.uniform === uniform &&
      c.whitespaceFlag === whitespaceFlag &&
      c.whitespaceSetId === whitespaceSetId
    ) {
      return c.result;
    }

    const result = this.#select(params.maxIndexesPerMark, uniform, params.includable);
    this.#cache = { maxIndexesPerMark: params.maxIndexesPerMark, uniform, whitespaceFlag, whitespaceSetId, result };
    return result;
  }

  /** The descending-weight greedy merge (study 03 §4.11, verbatim). */
  #select(gap: number, uniform: boolean, includable?: (mark: M) => boolean): M[] {
    const canInclude = (m: M): boolean => (includable === undefined ? true : includable(m));

    let accepted: M[] = [];
    for (const weight of this.#weightsDesc) {
      const marks = this.#byWeight.get(weight) as M[];
      const prev = accepted;
      accepted = [];
      let p = 0;
      let left = -Infinity;
      let right = Infinity;

      for (const mark of marks) {
        // copy over all higher-weight (already accepted) marks left of this one.
        while (p < prev.length && prev[p].index < mark.index && canInclude(prev[p])) {
          accepted.push(prev[p]);
          left = prev[p].index;
          right = Infinity;
          p++;
        }
        // nearest higher-weight mark to the right (if the walk stopped on one).
        if (p < prev.length && !(prev[p].index < mark.index && canInclude(prev[p]))) {
          right = prev[p].index;
        }
        if (right - mark.index >= gap && mark.index - left >= gap && canInclude(mark)) {
          accepted.push(mark);
          left = mark.index;
        } else if (uniform) {
          // all-or-nothing: one non-fitting mark rejects this whole weight level
          // (and every lower level, since we return immediately).
          return prev;
        }
      }
      // copy any remaining includable higher-weight marks.
      for (; p < prev.length; p++) {
        if (canInclude(prev[p])) accepted.push(prev[p]);
      }
    }
    return accepted;
  }
}
