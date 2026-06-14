// Gradient resolution + cache (design 03 §8.4). A string fill passes straight
// through; a LinearGradientY becomes createLinearGradient(0, from, 0, to) + stops.
// Coordinates are ALWAYS list-space (no pixel-ratio multiplier — the reference's
// mixed-space quirk is gone, deviation §11.5), so they are part of the cache key:
// a resize or zoom changes `from`/`to` and self-invalidates. A small string-keyed
// LRU (capacity 16) per surface; emitters reuse LinearGradientY objects when
// unchanged, so the common case is one Map hit per run.
import type { FillStyle, LinearGradientY } from '../gfx';

const CAPACITY = 16;

function isGradient(fill: FillStyle): fill is LinearGradientY {
  return typeof fill !== 'string';
}

function keyOf(g: LinearGradientY): string {
  let k = `${g.from}:${g.to}`;
  for (const s of g.stops) k += `:${s.offset},${s.color}`;
  return k;
}

export class GradientCache {
  // Map preserves insertion order; delete+set on hit moves an entry to the end
  // (most-recently-used), so the first key is always the eviction candidate.
  readonly #cache = new Map<string, CanvasGradient>();

  resolve(fill: FillStyle, ctx: CanvasRenderingContext2D): string | CanvasGradient {
    if (!isGradient(fill)) return fill;
    const key = keyOf(fill);
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, hit); // refresh recency
      return hit;
    }
    const grad = ctx.createLinearGradient(0, fill.from, 0, fill.to);
    for (const s of fill.stops) grad.addColorStop(s.offset, s.color);
    this.#cache.set(key, grad);
    if (this.#cache.size > CAPACITY) {
      const oldest = this.#cache.keys().next().value as string;
      this.#cache.delete(oldest);
    }
    return grad;
  }

  clear(): void {
    this.#cache.clear();
  }
}
