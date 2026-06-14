// views/series/buffer.ts — the hot-path scratch container (architecture §6).
//
// `ItemBuffer<Item>` is the moral equivalent of the reference's per-series
// rendered-points array (study 06 §4.4), columnar so `convert` fills `x`/`y`/`extra`
// in tight loops and `emit`/`hitTest` read them with no per-item object access.
// Backing arrays are owned by the series' scene source and reused frame-to-frame:
// `ensure` grows by amortized doubling and NEVER shrinks, so a steady-state frame
// allocates nothing (perf §5.1 rule A1; growth is counted as a buffer realloc and
// asserted 0 after warm-up, perf §4.4.7). The `DisplayListBuilder` has the parallel
// pooled-geometry discipline for command output.
import { assert } from '../../core';

/** The reusable, growable columnar item buffer (architecture §6 — member shapes
 *  pinned there). `convert` fills `x`/`y`/`extra`; `emit`/`hitTest` read. `item(i)`
 *  lazily materialises a payload view (style/colour reads) without per-item alloc
 *  on the geometry path. */
export interface ItemBuffer<Item> {
  /** Count of live converted items this frame. */
  length: number;
  /** media-px centre X per item (filled by convert). */
  readonly x: Float32Array;
  /** media-px Y per item; NaN = gap (whitespace / NaN value). */
  readonly y: Float32Array;
  /** kind-private 2nd-coordinate lane (OHLC hi/lo pixel pairs, baseline split-Y) —
   *  `laneStride` floats wide per item. */
  readonly extra: Float32Array;
  /** floats of `extra` per item (0 for single-Y kinds). */
  readonly laneStride: number;
  /** TimeIndex slot per item (for hit-test + diffs). */
  readonly timeIndex: Int32Array;
  /** Lazily-materialised payload view (style/colour reads). */
  item(i: number): Item;
  /** Grow backing arrays to hold `capacity` items; never shrinks (reuse next frame). */
  ensure(capacity: number): void;
}

/** Builds the lazy per-item payload view for `item(i)`. Receives the buffer and the
 *  row index so a kind can read its own lanes / reuse one flyweight object. */
export type ItemFactory<Item> = (buffer: ItemBuffer<Item>, index: number) => Item;

const INITIAL_CAPACITY = 16;

/** Reusable concrete `ItemBuffer<Item>`. Owned by a series scene source; one per
 *  series, reused every frame. Backing arrays grow by amortised doubling and never
 *  shrink. `length` is set by the engine after `convert`/`itemsFromStore`. */
export class ReusableItemBuffer<Item> implements ItemBuffer<Item> {
  length = 0;
  #x: Float32Array;
  #y: Float32Array;
  #extra: Float32Array;
  #timeIndex: Int32Array;
  readonly #laneStride: number;
  readonly #factory: ItemFactory<Item>;
  #capacity: number;
  /** Buffer-realloc counter (perf §4.4.7): incremented on every backing-array grow.
   *  Asserted 0 after warm-up in steady scenarios. */
  reallocs = 0;

  constructor(laneStride: number, factory: ItemFactory<Item>, initialCapacity = INITIAL_CAPACITY) {
    if (__DEV__) assert(laneStride >= 0 && Number.isInteger(laneStride), 'laneStride must be a non-negative integer');
    this.#laneStride = laneStride;
    this.#factory = factory;
    this.#capacity = Math.max(1, initialCapacity);
    this.#x = new Float32Array(this.#capacity);
    this.#y = new Float32Array(this.#capacity);
    this.#extra = new Float32Array(this.#capacity * laneStride);
    this.#timeIndex = new Int32Array(this.#capacity);
  }

  get x(): Float32Array {
    return this.#x;
  }
  get y(): Float32Array {
    return this.#y;
  }
  get extra(): Float32Array {
    return this.#extra;
  }
  get laneStride(): number {
    return this.#laneStride;
  }
  get timeIndex(): Int32Array {
    return this.#timeIndex;
  }

  /** Current backing capacity (items). For tests / realloc accounting. */
  capacity(): number {
    return this.#capacity;
  }

  ensure(capacity: number): void {
    if (capacity <= this.#capacity) return; // reuse — the steady-state path, no alloc
    let cap = this.#capacity;
    while (cap < capacity) cap *= 2; // amortised doubling (perf §5.1 A1)
    const x = new Float32Array(cap);
    x.set(this.#x);
    const y = new Float32Array(cap);
    y.set(this.#y);
    const ti = new Int32Array(cap);
    ti.set(this.#timeIndex);
    this.#x = x;
    this.#y = y;
    this.#timeIndex = ti;
    if (this.#laneStride > 0) {
      const extra = new Float32Array(cap * this.#laneStride);
      extra.set(this.#extra);
      this.#extra = extra;
    }
    this.#capacity = cap;
    this.reallocs++;
  }

  item(i: number): Item {
    if (__DEV__) assert(i >= 0 && i < this.length, 'item index out of range');
    return this.#factory(this, i);
  }
}
