// Backend text measurement (design 03 §7). The backend owns a hidden measuring
// context; `measure` sets its font from a FontSpec and reads measureText. Ascent /
// descent come from actualBoundingBoxAscent/Descent, with a 0.8·size / 0.2·size
// fallback when those fields are unavailable. No measure-during-paint: gfx's
// CachedTextMeasurer (the Layout-phase wrapper) calls this; replay never does.
import type { FontSpec, ITextMeasurer, TextSize } from '../gfx';

/** A CSS font shorthand `style weight size family` (the order Canvas expects). */
export function fontString(font: FontSpec): string {
  const style = font.style ?? 'normal';
  const weight = font.weight ?? 'normal';
  return `${style} ${weight} ${font.size}px ${font.family}`;
}

export class CanvasTextMeasurer implements ITextMeasurer {
  readonly #ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.#ctx = ctx;
  }

  measure(text: string, font: FontSpec): TextSize {
    this.#ctx.font = fontString(font);
    const m = this.#ctx.measureText(text);
    const ascent = m.actualBoundingBoxAscent;
    const descent = m.actualBoundingBoxDescent;
    return {
      width: m.width,
      // `typeof … === 'number'` rejects both `undefined` (field absent) and NaN.
      ascent: typeof ascent === 'number' ? ascent : font.size * 0.8,
      descent: typeof descent === 'number' ? descent : font.size * 0.2,
    };
  }
}
