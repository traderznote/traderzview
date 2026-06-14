// views/series/window.ts — the internal item-index slice (architecture §6).
//
// `ItemWindow` is the widened-to-integers visible slice (study 03 §4.3
// `strictRange = [floor(left), ceil(right)]`, study 04 §3 visibleStrictRange) that
// `convert`/`emit`/`decimate` use to touch only on-screen items (± the
// `extendedRange` neighbour for line-likes, which the engine adds before passing
// the window). It carries raw `number` item indices, NEVER a `Logical`/`Time`
// brand — it is a views-private engine struct, deliberately NOT named
// `VisibleRange` (doc 02 owns the public branded range types). It is exported only
// as part of the `SeriesKind` re-export so authors can name the parameter.

/** Integer `[from, to)` over the item buffer / store rows (architecture §6). */
export interface ItemWindow {
  /** Inclusive first on-screen item index. */
  readonly from: number;
  /** Exclusive end; `(to - from)` items to draw. */
  readonly to: number;
}

/** A reusable, mutable `ItemWindow` the engine re-points each frame with zero
 *  allocation. It satisfies `ItemWindow` structurally (its `from`/`to` are read
 *  through the readonly interface) while `set` mutates the same object in place,
 *  so a steady-state frame never allocates a window (perf §5.1). */
export class MutableItemWindow implements ItemWindow {
  #from = 0;
  #to = 0;

  get from(): number {
    return this.#from;
  }
  get to(): number {
    return this.#to;
  }

  /** Re-point the window in place. `from`/`to` are clamped to `from ≤ to`. */
  set(from: number, to: number): this {
    this.#from = from;
    this.#to = to < from ? from : to;
    return this;
  }

  /** Number of items in the slice. */
  count(): number {
    return this.#to - this.#from;
  }

  /** True when the slice is empty. */
  isEmpty(): boolean {
    return this.#to <= this.#from;
  }
}

/** Build a plain immutable `ItemWindow` snapshot (test/setup convenience; not a
 *  hot-path constructor — the engine reuses a `MutableItemWindow` per frame). */
export function itemWindow(from: number, to: number): ItemWindow {
  return { from, to: to < from ? from : to };
}
