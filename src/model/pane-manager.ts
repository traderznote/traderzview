// The pane registry (architecture §4.6 pane row; design 02 §11; study 05 A-4 / T8).
// Owns pane lifecycle (add / remove / move / swap) and — the load-bearing invariant
// — id MINTING: ids are `'p0','p1',…` in CREATION order, NEVER reused, and survive
// `removePane`/`moveTo`/`swapPanes` unchanged. `index()` renumbers on every
// structural change; `id()` does not. The never-reuse property is what lets drawing-
// tool anchors and saved layouts re-bind across sessions (design 05 §4.1).
import { Pane } from './pane';
import { formatPaneId, type PaneId } from './shared';

export class PaneManager {
  /** Position-ordered panes (top → bottom). `index()` reads this order. */
  readonly #panes: Pane[] = [];
  /** Monotonic creation counter — NEVER decremented, so ids are never reused. */
  #nextOrdinal = 0;

  /** The panes in position order (top → bottom). */
  panes(): readonly Pane[] {
    return this.#panes.slice();
  }

  count(): number {
    return this.#panes.length;
  }

  /** The positional index of a pane, or -1 if it is not in this manager. */
  indexOf(pane: Pane): number {
    return this.#panes.indexOf(pane);
  }

  paneById(id: PaneId): Pane | null {
    return this.#panes.find((p) => p.id() === id) ?? null;
  }

  /**
   * Mint a new pane and append it at the bottom. The id is the next creation
   * ordinal (`'p<n>'`), guaranteed never reused because `#nextOrdinal` only ever
   * increments — even across removals (05 A-4 / T8).
   */
  addPane(): Pane {
    const pane = new Pane(formatPaneId(this.#nextOrdinal));
    this.#nextOrdinal++;
    this.#panes.push(pane);
    return pane;
  }

  /** Insert an externally-minted pane (used by ChartModel for the default pane). */
  addExisting(pane: Pane): void {
    this.#panes.push(pane);
  }

  /** Remove a pane (positions of the survivors shift; their ids do NOT change). */
  removePane(pane: Pane): void {
    const i = this.#panes.indexOf(pane);
    if (i >= 0) this.#panes.splice(i, 1);
  }

  /** Move a pane to a new positional index (design 02 §11: throws RangeError when
   *  out of bounds). `id()` is unchanged; only `index()` renumbers. */
  moveTo(pane: Pane, targetIndex: number): void {
    const from = this.#panes.indexOf(pane);
    if (from < 0) throw new RangeError('pane is not in this manager');
    if (targetIndex < 0 || targetIndex >= this.#panes.length) {
      throw new RangeError(`pane index ${targetIndex} out of bounds`);
    }
    this.#panes.splice(from, 1);
    this.#panes.splice(targetIndex, 0, pane);
  }

  /** Swap the panes at two positions (ids unchanged; only positions exchange). */
  swapPanes(i: number, j: number): void {
    const n = this.#panes.length;
    if (i < 0 || i >= n || j < 0 || j >= n) {
      throw new RangeError('swapPanes index out of bounds');
    }
    const tmp = this.#panes[i];
    this.#panes[i] = this.#panes[j];
    this.#panes[j] = tmp;
  }
}
