// Text measurement seam (design 03 §7, study 10 §4.7). The backend supplies the
// raw measure function (canvas measureText, no measure-during-paint); gfx owns the
// interface and the caching wrapper. Keys fold digits 2-9 → 0 (chart fonts use
// equal-width figures), so "12.34" and "19.87" share one measurement. True Map-LRU.
import type { FontSpec } from './commands';

export interface TextSize {
  readonly width: number;
  readonly ascent: number; // actualBoundingBoxAscent
  readonly descent: number; // actualBoundingBoxDescent
}

export interface ITextMeasurer {
  measure(text: string, font: FontSpec): TextSize;
}

function fontKey(f: FontSpec): string {
  return `${f.weight ?? 'normal'}|${f.style ?? 'normal'}|${f.size}|${f.family}`;
}

export class CachedTextMeasurer implements ITextMeasurer {
  readonly #raw: (text: string, font: FontSpec) => TextSize;
  readonly #capacity: number;
  readonly #cache = new Map<string, TextSize>();
  #fontKey: string | undefined;

  constructor(raw: (text: string, font: FontSpec) => TextSize, capacity = 50) {
    this.#raw = raw;
    this.#capacity = capacity;
  }

  measure(text: string, font: FontSpec): TextSize {
    const fk = fontKey(font);
    if (fk !== this.#fontKey) {
      this.#cache.clear(); // a font change invalidates every cached width
      this.#fontKey = fk;
    }
    const key = text.replace(/[2-9]/g, '0');
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      this.#cache.delete(key); // reinsert → most-recently-used
      this.#cache.set(key, hit);
      return hit;
    }
    const size = this.#raw(text, font);
    // Firefox quirk: measureText can return 0 for non-empty text depending on canvas
    // size. Return it, but never cache, so a later correct measurement replaces it.
    if (size.width === 0 && text.length > 0) {
      return size;
    }
    this.#cache.set(key, size);
    if (this.#cache.size > this.#capacity) {
      const oldest = this.#cache.keys().next().value as string;
      this.#cache.delete(oldest);
    }
    return size;
  }
}
