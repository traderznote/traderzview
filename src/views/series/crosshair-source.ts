// views/series/crosshair-source.ts — the Crosshair SceneSource (band Crosshair,
// study 07 §3.5/§5; design 03 §8.5.8 + matrix 256). The VIEW face only: crosshair
// STATE lives in model/crosshair.ts (read-only here). Emits the vertical line at the
// applied media-x (full bitmap height) and the horizontal line at the applied media-y
// (full bitmap width), each its OWN bitmap `polyline` so vert/horz keep independent
// width+dash. Crisp positions via `crispStrokePos`; the horizontal off-pane skip
// (y·vr outside [0, bitmapH] → no horizontal line) is kept. Nothing renders while the
// crosshair is not renderVisible (mode Hidden / cleared). Per-source cache identity
// (perf §4.4.2): a clean frame returns the byte-identical cached array; only a real
// state/geometry change rebuilds it.
import { crispStrokePos, crispWidth, DisplayListBuilder, LineStyle, ZBand } from '../../gfx';
import type { DisplayList, FillStyle, SceneSource, ViewFrame } from '../../gfx';
import type { Crosshair } from '../../model';

/** One crosshair line's style (study 07 §3.7 / design 02 §6.4 vertLine/horzLine). */
export interface CrosshairLineOptions {
  readonly color: FillStyle;
  /** Media-px width, ≥ 1 (default 1). */
  readonly width: number;
  readonly style: LineStyle;
  readonly visible: boolean;
}

const DEFAULT_LINE: CrosshairLineOptions = {
  color: '#9598A1',
  width: 1,
  style: LineStyle.LargeDashed,
  visible: true,
};

/** Merge partial line options over the reference defaults (design 02 §6.4). */
function resolveLine(o?: Partial<CrosshairLineOptions>): CrosshairLineOptions {
  return {
    color: o?.color ?? DEFAULT_LINE.color,
    width: o?.width ?? DEFAULT_LINE.width,
    style: o?.style ?? DEFAULT_LINE.style,
    visible: o?.visible ?? DEFAULT_LINE.visible,
  };
}

const EMPTY: readonly DisplayList[] = [];

/** Constructor options: per-line partials over the vertLine/horzLine defaults. */
export interface CrosshairSourceOptions {
  readonly vertLine?: Partial<CrosshairLineOptions>;
  readonly horzLine?: Partial<CrosshairLineOptions>;
}

/**
 * Build the Crosshair `SceneSource`. `crosshair` is the model owner (read-only); the
 * source only converts its applied coords into crisp bitmap polylines. The applied
 * x/y already carry the bar-snap / magnet alignment the host re-derived (study 07
 * §3.5), so the view does no snapping itself.
 */
export function createCrosshairSource(crosshair: Crosshair, options?: CrosshairSourceOptions): SceneSource {
  const vert = resolveLine(options?.vertLine);
  const horz = resolveLine(options?.horzLine);
  const builder = new DisplayListBuilder();

  let cached: readonly DisplayList[] = EMPTY;
  // The signature of the state the cached lists were built from. A clean frame whose
  // signature matches keeps the IDENTICAL array (perf §4.4.2); any change rebuilds.
  let sig: string | null = null; // null forces the first build

  function signature(frame: ViewFrame): string {
    const p = crosshair.position();
    if (p === null || !crosshair.renderVisible()) return 'hidden';
    const f = frame.frame;
    // applied media coords + the device geometry that crisps them.
    return `${p.x}|${p.y}|${f.hr}|${f.vr}|${f.bitmapSize.width}|${f.bitmapSize.height}`;
  }

  function build(frame: ViewFrame): readonly DisplayList[] {
    const p = crosshair.position();
    if (p === null || !crosshair.renderVisible()) return EMPTY;
    const x = p.x as number;
    const y = p.y as number;
    const f = frame.frame;
    const hr = f.hr;
    const vr = f.vr;
    const bw = f.bitmapSize.width;
    const bh = f.bitmapSize.height;

    const drawVert = vert.visible && Number.isFinite(x);
    // Horizontal line off-pane skip (design 03 §8.5.8): a y outside [0, bitmapH] in
    // device space draws nothing — the pointer is in another pane.
    const yDev = y * vr;
    const drawHorz = horz.visible && Number.isFinite(y) && yDev >= 0 && yDev <= bh;
    if (!drawVert && !drawHorz) return EMPTY;

    builder.reset();
    builder.beginList('bitmap');
    if (drawVert) {
      const w = crispWidth(vert.width, hr); // bitmap line width, ≥ 1
      const px = crispStrokePos(x, hr, w); // odd-width half-pixel shift on the parity ref
      const poly = builder.polyline(w, vert.style, 'miter');
      poly.vertex(px, 0, vert.color);
      poly.vertex(px, bh, vert.color);
    }
    if (drawHorz) {
      const w = crispWidth(horz.width, vr);
      const py = crispStrokePos(y, vr, w);
      const poly = builder.polyline(w, horz.style, 'miter');
      poly.vertex(0, py, horz.color);
      poly.vertex(bw, py, horz.color);
    }
    return builder.finish();
  }

  return {
    zBand: ZBand.Crosshair,
    update(frame: ViewFrame): void {
      const next = signature(frame);
      if (next === sig) return; // clean: keep the cached array reference
      sig = next;
      cached = build(frame);
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
  };
}
