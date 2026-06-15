// traderzview · extras/watermark — the text watermark plugin (design 05 §2.7 item 3;
// study 08 §4.5 is the layout spec of record). createTextWatermark attaches a PANE-
// attached IPrimitive that registers ONE BelowSeries-band SceneSource (target 'pane',
// so it sits under all series by BAND, not the reference's "pane primitives draw first"
// rule). It emits a media-space `text` command: N lines, each with a per-line FITTED
// (shrink-to-fit) font size and the §4.5 horizontal/vertical alignment. applyOptions
// live-updates through the §12.4 adapter; detached() drops the captured context (§2.2).
// Built ONLY on the public api seams (IPrimitive/PrimitiveContext + the pane attach
// surface) + gfx + the extras/shared adapter — never model/views (arch §3.1).
import { CachedTextMeasurer, DisplayListBuilder, ZBand } from '../../gfx';
import type { DisplayList, SceneSource, TextItem, ViewFrame } from '../../gfx';
import type { DeepPartial } from '../../core';
import { createPrimitiveAdapter } from '../shared';
import type { PrimitiveAdapter, PrimitiveTarget } from '../shared';
import type { IPrimitive, PrimitiveContext } from '../../api';

// --- public option shapes (study 08 §4.5 defaults; kept) ---------------------------

/** Where the block sits horizontally / vertically in the pane (study 08 §4.5). */
export type TextWatermarkHorzAlign = 'left' | 'center' | 'right';
export type TextWatermarkVertAlign = 'top' | 'center' | 'bottom';

/** One watermark line. `lineHeight` defaults to `fontSize × 1.2` (study 08 §4.5). */
export interface TextWatermarkLine {
  text: string;
  color: string;
  fontSize: number;
  fontFamily?: string;
  fontStyle?: string;
  lineHeight?: number;
}

/** Plugin options (standard §5.1 merge via the adapter). */
export interface TextWatermarkOptions {
  visible: boolean;
  horzAlign: TextWatermarkHorzAlign;
  vertAlign: TextWatermarkVertAlign;
  lines: readonly TextWatermarkLine[];
}

const DEFAULT_FONT_FAMILY =
  "-apple-system, system-ui, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export const textWatermarkDefaults: TextWatermarkOptions = {
  visible: true,
  horzAlign: 'center',
  vertAlign: 'center',
  lines: [],
};

/** The §12.4 adapter handle: { detach, applyOptions } (no factory-specific methods). */
export type TextWatermarkHandle = PrimitiveAdapter<TextWatermarkOptions>;

const EMPTY: readonly DisplayList[] = [];

// --- the SceneSource: the §4.5 two-pass media-space layout -------------------------

/** A laid-out line ready to emit: its fitted font size + media-space anchor. */
interface PlacedLine {
  readonly item: TextItem;
}

/** The pane geometry the source reads through the public seam — `ctx.pane.size()`. */
interface PaneLike {
  size(): { width: number; height: number };
}

function createWatermarkSource(
  getOptions: () => TextWatermarkOptions,
  getPane: () => PaneLike | null,
  getRev: () => number,
): SceneSource {
  const builder = new DisplayListBuilder();
  // §2.7 item 4: all four plugins fold through gfx's CachedTextMeasurer. No backend
  // measurer is reachable from the public PrimitiveContext, so we wrap a deterministic
  // per-char estimate; the REAL draw measures via the backend (the text command carries
  // the font). The zoom math only needs a stable, per-(font,text)-cached width.
  const measurer = new CachedTextMeasurer((text, font) => ({
    width: text.length * font.size * 0.6,
    ascent: font.size * 0.8,
    descent: font.size * 0.2,
  }));
  let cached: readonly DisplayList[] = EMPTY;
  let sig: string | null = null;

  function layout(paneW: number, paneH: number): readonly PlacedLine[] {
    const opts = getOptions();
    if (!opts.visible || opts.lines.length === 0 || paneW <= 0 || paneH <= 0) return [];

    // --- pass 1: per-line shrink-to-fit zoom + total stacked height (§4.5) ----------
    interface Pass1 {
      readonly line: TextWatermarkLine;
      readonly lineHeight: number;
      readonly zoom: number;
    }
    const rows: Pass1[] = [];
    let totalHeight = 0;
    for (const line of opts.lines) {
      const lineHeight = line.lineHeight ?? line.fontSize * 1.2;
      if (line.text.length === 0) {
        // an empty line contributes its height but no zoom/draw (study 08 §4.5)
        rows.push({ line, lineHeight, zoom: 1 });
        totalHeight += lineHeight;
        continue;
      }
      const w = measurer.measure(line.text, {
        family: line.fontFamily ?? DEFAULT_FONT_FAMILY,
        size: line.fontSize,
        style: line.fontStyle === 'italic' ? 'italic' : 'normal',
      }).width;
      // zoom only ever SHRINKS, never enlarges (study 08 §4.5 / §4.4 gotcha).
      const zoom = w > paneW ? paneW / w : 1;
      rows.push({ line, lineHeight, zoom });
      totalHeight += lineHeight * zoom;
    }

    // vertOffset clamps at 0 so overflow clips at the BOTTOM (study 08 §4.5 / gotcha).
    let vertOffset =
      opts.vertAlign === 'top'
        ? 0
        : opts.vertAlign === 'center'
          ? Math.max((paneH - totalHeight) / 2, 0)
          : Math.max(paneH - totalHeight, 0);

    // --- pass 2: place each line (§4.5 horzOffset by align; baseline conversion) -----
    const out: PlacedLine[] = [];
    for (const r of rows) {
      const zh = r.lineHeight * r.zoom;
      if (r.line.text.length > 0) {
        const size = r.line.fontSize * r.zoom;
        const family = r.line.fontFamily ?? DEFAULT_FONT_FAMILY;
        const style = r.line.fontStyle === 'italic' ? 'italic' : 'normal';
        const w = measurer.measure(r.line.text, { family, size: r.line.fontSize, style }).width * r.zoom;
        // §4.5 horzOffset is the ANCHOR (left/center/right) in canvas textAlign terms;
        // our TextItem.x is the LEFT edge, so subtract the appropriate share of w.
        const lh = r.lineHeight * r.zoom;
        let x: number;
        if (opts.horzAlign === 'left') x = lh / 2;
        else if (opts.horzAlign === 'center') x = paneW / 2 - w / 2;
        else x = paneW - 1 - lh / 2 - w; // right: width − 1 − lineHeight/2 anchor (note the −1)
        // §4.5 draws with textBaseline 'top' at vertOffset; our TextItem.y is the
        // alphabetic baseline, so push down by the ascent of the fitted glyph.
        out.push({
          item: {
            x,
            y: vertOffset + size * 0.8,
            text: r.line.text,
            font: { family, size, style },
            color: r.line.color,
          },
        });
      }
      vertOffset += zh;
    }
    return out;
  }

  function build(): readonly DisplayList[] {
    const pane = getPane();
    if (pane === null) return EMPTY;
    const { width, height } = pane.size();
    const placed = layout(width, height);
    if (placed.length === 0) return EMPTY;
    builder.reset();
    builder.beginList('media'); // resolution-independent text (study 08 §2)
    builder.text(placed.map((p) => p.item));
    return builder.finish();
  }

  return {
    zBand: ZBand.BelowSeries, // under all series by band (design 05 §2.7 item 3 / §2.3)
    update(_frame: ViewFrame): void {
      const sz = getPane()?.size();
      // The option revision (bumped on every applyOptions/onChange) forces a rebuild
      // even when line count + pane size are unchanged (a text/align/color edit).
      const next = `${getRev()}|${sz?.width}|${sz?.height}`;
      if (next === sig) return;
      sig = next;
      cached = build();
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
  };
}

// --- the factory (design 02 §12.4: createTextWatermark(pane, options?)) -------------

/**
 * Attach a text-watermark primitive to `pane`. Returns the §12.4 adapter handle
 * (`{ detach, applyOptions }`). The adapter attaches on construction and schedules the
 * first Render frame (§2.2); `applyOptions` live-merges the lines/alignment and dirties
 * the source; auto-detach (pane removal / chart.dispose) funnels through the same
 * idempotent teardown. `detached()` drops the captured context (no leaked handles).
 */
export function createTextWatermark(
  pane: PrimitiveTarget & PaneLike,
  options?: DeepPartial<TextWatermarkOptions>,
): TextWatermarkHandle {
  // The adapter owns the §5.1 merge; we keep a mutable mirror for the source to read.
  let opts: TextWatermarkOptions = resolve(options);
  let rev = 0; // bumps on every option change so the source re-layouts (see update()).

  let ctx: PrimitiveContext | null = null;
  // The source reads the live pane size through ctx.pane (the §11 IPane.size()); before
  // attach we read the pane handle directly (it IS the PaneLike target passed in).
  const source = createWatermarkSource(
    () => opts,
    () => (ctx?.pane as unknown as PaneLike | undefined) ?? pane,
    () => rev,
  );

  const primitive: IPrimitive = {
    attached(c): void {
      ctx = c as unknown as PrimitiveContext;
    },
    detached(): void {
      ctx = null;
    },
    sources(): readonly { target: 'pane'; source: SceneSource }[] {
      return [{ target: 'pane', source }];
    },
  };

  return createPrimitiveAdapter<TextWatermarkOptions>({
    target: pane,
    primitive,
    options: opts,
    defaults: textWatermarkDefaults,
    onChange(next): void {
      opts = next;
      rev++;
      ctx?.requestUpdate('render'); // a BelowSeries base-layer band → a Render frame
    },
    methods: {},
  });
}

/** Merge the initial patch over the kept defaults (standard §5.1 shallow resolve — the
 *  `lines` array is replaced wholesale, never element-merged). */
function resolve(patch?: DeepPartial<TextWatermarkOptions>): TextWatermarkOptions {
  if (patch === undefined) return { ...textWatermarkDefaults };
  return {
    visible: patch.visible ?? textWatermarkDefaults.visible,
    horzAlign: (patch.horzAlign as TextWatermarkHorzAlign) ?? textWatermarkDefaults.horzAlign,
    vertAlign: (patch.vertAlign as TextWatermarkVertAlign) ?? textWatermarkDefaults.vertAlign,
    lines: (patch.lines as readonly TextWatermarkLine[]) ?? textWatermarkDefaults.lines,
  };
}
