// views/series/last-value-label.ts — the last-value axis-label SceneSource (study 06
// §4.14; design 01 §5.4 / §6 band Labels; design 03 §8.5 recipe "Last-value axis label
// (pill)"). A media-space rounded-rect tag + centered text on a price-axis surface at a
// series last value's Y. `provider` feeds {y, text, color} each frame (the model walk
// stays out of views, §3.1); the source derives generateContrastColors (alpha-stripped
// fill = background, foreground text, raw color border, study 06 §4.14), lays out the
// pill at the axis right edge, and caches the list (perf §4.4.2: clean → byte-identical
// array; any state/geometry change → a fresh array). Off-pane y (outside the surface
// height in media px) emits nothing.
import { DisplayListBuilder, ZBand } from '../../gfx';
import type { DisplayList, FontSpec, ITextMeasurer, SceneSource, ViewFrame } from '../../gfx';

/** Per-frame state from the model-side owner: `y` the label's media-px coordinate
 *  (`priceToCoordinate`, null = no data → hidden), `text` the formatted price, `color`
 *  the raw resolved last-bar color (border + contrast basis, study 06 §4.14). */
export interface LastValueLabelState {
  readonly y: number | null;
  readonly text: string;
  readonly color: string;
}

/** Pill style + visibility (study 06 §4.14 / §4.17). */
export interface LastValueLabelOptions {
  readonly visible: boolean;
  readonly font: FontSpec;
  /** Horizontal text padding inside the pill, media px (default 4). */
  readonly padH: number;
  /** Vertical text padding inside the pill, media px (default 2). */
  readonly padV: number;
  /** Corner radius, media px (default 2). */
  readonly radius: number;
  /** Border stroke width, media px (default 1). */
  readonly borderWidth: number;
  /** Gap from the axis right edge to the pill, media px (default 0). */
  readonly margin: number;
}

const DEFAULTS: LastValueLabelOptions = {
  visible: true,
  font: { family: 'sans-serif', size: 11 },
  padH: 4,
  padV: 2,
  radius: 2,
  borderWidth: 1,
  margin: 0,
};

const resolve = (o?: Partial<LastValueLabelOptions>): LastValueLabelOptions => ({
  visible: o?.visible ?? DEFAULTS.visible,
  font: o?.font ?? DEFAULTS.font,
  padH: o?.padH ?? DEFAULTS.padH,
  padV: o?.padV ?? DEFAULTS.padV,
  radius: o?.radius ?? DEFAULTS.radius,
  borderWidth: o?.borderWidth ?? DEFAULTS.borderWidth,
  margin: o?.margin ?? DEFAULTS.margin,
});

const EMPTY: readonly DisplayList[] = Object.freeze([]);

/** Resolved {background, foreground} for the pill (study 06 §4.14 "Contrast colors"):
 *  parse to rgb (alpha stripped), luma = 0.199·r + 0.687·g + 0.114·b, foreground is
 *  'black' when luma > 160 else 'white'. Unparseable colors fall back to a dark pill. */
export function generateContrastColors(color: string): { background: string; foreground: string } {
  const rgb = parseRgb(color);
  if (rgb === null) return { background: color, foreground: 'white' };
  const [r, g, b] = rgb;
  const luma = 0.199 * r + 0.687 * g + 0.114 * b;
  return { background: `rgb(${r}, ${g}, ${b})`, foreground: luma > 160 ? 'black' : 'white' };
}

/** Minimal CSS color parse → [r,g,b] (alpha discarded) for #rgb / #rrggbb / rgb()/rgba(). */
function parseRgb(c: string): [number, number, number] | null {
  const s = c.trim();
  if (s.charCodeAt(0) === 35 /* # */) {
    const h = s.slice(1);
    if (h.length === 3) return [d2(h[0]! + h[0]!), d2(h[1]! + h[1]!), d2(h[2]! + h[2]!)];
    if (h.length === 6 || h.length === 8) return [d2(h.slice(0, 2)), d2(h.slice(2, 4)), d2(h.slice(4, 6))];
    return null;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m === null) return null;
  const p = m[1]!.split(',');
  if (p.length < 3) return null;
  return [byte(p[0]!), byte(p[1]!), byte(p[2]!)];
}

const d2 = (h: string): number => parseInt(h, 16);
const byte = (v: string): number => Math.max(0, Math.min(255, Math.round(parseFloat(v))));

/**
 * Build a last-value axis-label `SceneSource` (band Labels). `provider` returns the live
 * state each frame; `measurer` sizes the text (the backend's measurer via the seam). The
 * source lays out one media `rects` pill (radius + raw-color stroke, contrast fill) and
 * one centered `text`, caching the list and re-emitting only when an input changes.
 */
export function createLastValueLabelSource(
  provider: () => LastValueLabelState,
  measurer: ITextMeasurer,
  options?: Partial<LastValueLabelOptions>,
): SceneSource {
  const o = resolve(options);
  const builder = new DisplayListBuilder();
  let cached: readonly DisplayList[] = EMPTY;
  let sig: string | null = null; // null forces the first build

  // Drawable iff visible, has a finite y, and that y is on this surface (media px).
  const drawable = (s: LastValueLabelState, h: number): boolean =>
    o.visible && s.y !== null && Number.isFinite(s.y) && s.y >= 0 && s.y <= h && s.text.length > 0;

  function signature(s: LastValueLabelState, w: number, h: number): string {
    if (!drawable(s, h)) return 'hidden';
    return `${s.y}|${s.text}|${s.color}|${w}|${h}`;
  }

  function build(s: LastValueLabelState, w: number, h: number): readonly DisplayList[] {
    if (!drawable(s, h)) return EMPTY;
    const size = measurer.measure(s.text, o.font);
    const { background, foreground } = generateContrastColors(s.color);
    // Pill: text box + symmetric padding; right-aligned at the axis edge (− margin).
    const pillW = size.width + 2 * o.padH;
    const pillH = size.ascent + size.descent + 2 * o.padV;
    const right = w - o.margin;
    const left = right - pillW;
    const top = (s.y as number) - pillH / 2; // vertically centered on the coordinate
    // Text: center → x = anchor − width/2 ; baseline y = centerY + (ascent − descent)/2
    // (design 03 §8.5 emitter math). centerX = left + pillW/2 ; centerY = s.y.
    const textX = left + pillW / 2 - size.width / 2;
    const textY = (s.y as number) + (size.ascent - size.descent) / 2;

    builder.reset();
    builder.beginList('media');
    builder
      .rects({ radius: o.radius, stroke: { width: o.borderWidth, color: s.color } })
      .quad(left, top, pillW, pillH, background);
    builder.text([{ x: textX, y: textY, text: s.text, font: o.font, color: foreground }]);
    return builder.finish();
  }

  return {
    zBand: ZBand.Labels,
    update(frame: ViewFrame): void {
      const s = provider();
      const w = frame.frame.mediaSize.width;
      const h = frame.frame.mediaSize.height;
      const next = signature(s, w, h);
      if (next === sig) return; // clean: keep the cached array reference
      sig = next;
      cached = build(s, w, h);
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
  };
}
