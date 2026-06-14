// Command replay (design 03 §8.3): the seven-command switch + dash/run helpers +
// the 'copy' clear+fill fast path. The backend draws bitmap-space geometry VERBATIM
// (never rounds, never adds 0.5 — emitters did that via gfx/crisp). Geometry in
// list space; styles inline per command/run; no retained state survives a layer.
import { assert } from '../core';
import type {
  AreaCommand,
  CirclesCommand,
  DisplayList,
  DrawCommand,
  ImageCommand,
  ImageHandle,
  PathCommand,
  PolylineCommand,
  RectsCommand,
  StrokeSpec,
  TextCommand,
} from '../gfx';
import { dashPattern, LineStyle, PathVerb } from '../gfx';
import type { GradientCache } from './gradient';
import { fontString } from './text';

// The opaque ImageHandle a Canvas image carries — its source is a CanvasImageSource.
// Declared here (not imported from image.ts) to keep replay independent of it.
interface CanvasImageHandle extends ImageHandle {
  readonly source: CanvasImageSource;
}

/**
 * The 'copy' fast-path predicate, EXACTLY (design 03 §8.3): the layer's list array
 * is a SINGLE bitmap list with NO clip, whose first (relevant) command is a `rects`
 * of ONE quad covering the full bitmap (0,0,bw,bh), with no radius and no stroke.
 * No opacity check — `copy` replaces destination pixels, so a translucent fill
 * yields a translucent surface, identical to clear-then-fill.
 */
export function isCopyFastPath(lists: readonly DisplayList[], bitmapW: number, bitmapH: number): boolean {
  if (lists.length !== 1) return false;
  const list = lists[0];
  if (list.space !== 'bitmap' || list.clip !== undefined) return false;
  // Exactly one command: a second command would be dropped by the copy fill, so the
  // background fast path is the single-full-quad case only (a Background band source
  // emits exactly one quad; anything richer takes the ordinary clear+replay path).
  if (list.commands.length !== 1) return false;
  const cmd = list.commands[0];
  if (cmd.kind !== 'rects') return false;
  if (cmd.radius !== undefined || cmd.stroke !== undefined) return false;
  if (cmd.runs.length === 0) return false; // the fill comes from runs[0]; empty → ordinary path
  if (cmd.coords.length !== 4) return false; // exactly one quad
  const [x, y, w, h] = cmd.coords;
  return x === 0 && y === 0 && w === bitmapW && h === bitmapH;
}

/** Replay a whole layer onto `ctx` (clear/copy + per-list transform/clip + commands). */
export function replayLists(
  ctx: CanvasRenderingContext2D,
  lists: readonly DisplayList[],
  bitmapW: number,
  bitmapH: number,
  hr: number,
  vr: number,
  cache: GradientCache,
): void {
  if (isCopyFastPath(lists, bitmapW, bitmapH)) {
    const cmd = lists[0].commands[0] as RectsCommand;
    ctx.resetTransform();
    const prev = ctx.globalCompositeOperation;
    ctx.globalCompositeOperation = 'copy';
    ctx.fillStyle = cache.resolve(cmd.runs[0].fill, ctx);
    ctx.fillRect(0, 0, bitmapW, bitmapH);
    ctx.globalCompositeOperation = prev;
    return;
  }

  ctx.resetTransform();
  ctx.clearRect(0, 0, bitmapW, bitmapH);

  for (const list of lists) {
    ctx.save();
    if (list.space === 'media') ctx.setTransform(hr, 0, 0, vr, 0, 0);
    else ctx.resetTransform();
    if (list.clip !== undefined) {
      // clip is ALWAYS media px; bitmap lists draw under identity, so convert it.
      const c = list.clip;
      ctx.beginPath();
      if (list.space === 'bitmap') ctx.rect(c.x * hr, c.y * vr, c.width * hr, c.height * vr);
      else ctx.rect(c.x, c.y, c.width, c.height);
      ctx.clip();
    }
    for (const cmd of list.commands) replayCommand(ctx, cmd, cache);
    ctx.restore();
  }
}

function replayCommand(ctx: CanvasRenderingContext2D, cmd: DrawCommand, cache: GradientCache): void {
  switch (cmd.kind) {
    case 'rects':
      return drawRects(ctx, cmd, cache);
    case 'polyline':
      return drawPolyline(ctx, cmd, cache);
    case 'area':
      return drawArea(ctx, cmd, cache);
    case 'circles':
      return drawCircles(ctx, cmd, cache);
    case 'path':
      return drawPath(ctx, cmd, cache);
    case 'text':
      return drawText(ctx, cmd);
    case 'image':
      return drawImage(ctx, cmd);
  }
}

function applyStroke(ctx: CanvasRenderingContext2D, stroke: StrokeSpec, cache: GradientCache): void {
  // Reset join/cap to the canvas defaults so a prior `polyline` (which sets
  // lineJoin = its join, e.g. 'round') never leaks into this stroke. StrokeSpec
  // carries no join/cap, so the seam default applies (§3.1: no command implies
  // state for the next). Each stroke pass is thus self-contained.
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';
  ctx.lineWidth = stroke.width;
  ctx.lineDashOffset = 0;
  ctx.setLineDash(dashPattern(stroke.style ?? LineStyle.Solid, stroke.width));
  ctx.strokeStyle = cache.resolve(stroke.color, ctx);
}

function drawRects(ctx: CanvasRenderingContext2D, cmd: RectsCommand, cache: GradientCache): void {
  const { coords, runs, radius, stroke } = cmd;
  let q = 0; // quad index
  for (const run of runs) {
    ctx.beginPath();
    for (let i = 0; i < run.count; i++, q++) {
      const o = q * 4;
      if (radius !== undefined) ctx.roundRect(coords[o], coords[o + 1], coords[o + 2], coords[o + 3], radius);
      else ctx.rect(coords[o], coords[o + 1], coords[o + 2], coords[o + 3]);
    }
    ctx.fillStyle = cache.resolve(run.fill, ctx);
    ctx.fill();
  }
  if (stroke !== undefined) {
    applyStroke(ctx, stroke, cache);
    ctx.beginPath();
    const n = coords.length / 4;
    for (let k = 0; k < n; k++) {
      const o = k * 4;
      if (radius !== undefined) ctx.roundRect(coords[o], coords[o + 1], coords[o + 2], coords[o + 3], radius);
      else ctx.rect(coords[o], coords[o + 1], coords[o + 2], coords[o + 3]);
    }
    ctx.stroke();
  }
}

function drawPolyline(ctx: CanvasRenderingContext2D, cmd: PolylineCommand, cache: GradientCache): void {
  const { points, runs, width, style, join } = cmd;
  ctx.lineCap = 'butt';
  ctx.lineJoin = join;
  ctx.lineWidth = width;
  const pattern = dashPattern(style, width);
  const patternLen = pattern.reduce((a, b) => a + b, 0);
  ctx.setLineDash(pattern);

  let v = 0; // current vertex index across the whole points array
  let acc = 0; // accumulated dash arc length (continuity across runs, study 06 §4.4)
  for (const run of runs) {
    if (patternLen > 0) {
      ctx.lineDashOffset = acc % patternLen;
    } else {
      ctx.lineDashOffset = 0;
    }
    ctx.beginPath();
    let penDown = false;
    let px = 0;
    let py = 0;
    // walk this run's vertices plus the one-vertex extension into the next run.
    const end = v + run.count;
    const last = Math.min(end + 1, points.length / 2); // extension vertex when it exists
    for (let i = v; i < last; i++) {
      const x = points[i * 2];
      const y = points[i * 2 + 1];
      if (Number.isNaN(x)) {
        penDown = false; // gap: lift the pen
        continue;
      }
      if (!penDown) {
        ctx.moveTo(x, y);
        penDown = true;
      } else {
        ctx.lineTo(x, y);
        // Every segment this run draws (including the one-vertex extension into the
        // next run) advances the shared dash phase. The boundary segment is drawn by
        // this run only — the next run re-anchors at its first vertex with a moveTo —
        // so there is no double count (study 06 §4.4 dash continuity, kept).
        acc += Math.hypot(x - px, y - py);
      }
      px = x;
      py = y;
    }
    ctx.strokeStyle = cache.resolve(run.fill, ctx);
    ctx.stroke();
    v = end;
  }
}

function drawArea(ctx: CanvasRenderingContext2D, cmd: AreaCommand, cache: GradientCache): void {
  const { points, baseY, fill } = cmd;
  ctx.beginPath();
  const n = points.length / 2;
  let segStart = -1; // index of first vertex of the current segment, or -1 between
  let lastX = 0;
  for (let i = 0; i < n; i++) {
    const x = points[i * 2];
    const y = points[i * 2 + 1];
    if (Number.isNaN(x)) {
      if (segStart >= 0) {
        ctx.lineTo(lastX, baseY);
        ctx.lineTo(points[segStart * 2], baseY);
        ctx.closePath();
        segStart = -1;
      }
      continue;
    }
    if (segStart < 0) {
      ctx.moveTo(x, y);
      segStart = i;
    } else {
      ctx.lineTo(x, y);
    }
    lastX = x;
  }
  if (segStart >= 0) {
    ctx.lineTo(lastX, baseY);
    ctx.lineTo(points[segStart * 2], baseY);
    ctx.closePath();
  }
  ctx.fillStyle = cache.resolve(fill, ctx);
  ctx.fill();
}

function drawCircles(ctx: CanvasRenderingContext2D, cmd: CirclesCommand, cache: GradientCache): void {
  const { coords, runs, stroke } = cmd;
  let c = 0; // circle index
  for (const run of runs) {
    ctx.beginPath();
    for (let i = 0; i < run.count; i++, c++) {
      const o = c * 3;
      const x = coords[o];
      const y = coords[o + 1];
      const r = coords[o + 2];
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = cache.resolve(run.fill, ctx);
    ctx.fill();
  }
  if (stroke !== undefined) {
    applyStroke(ctx, stroke, cache);
    ctx.beginPath();
    const n = coords.length / 3;
    for (let k = 0; k < n; k++) {
      const o = k * 3;
      const x = coords[o];
      const y = coords[o + 1];
      const r = coords[o + 2];
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.stroke();
  }
}

function drawPath(ctx: CanvasRenderingContext2D, cmd: PathCommand, cache: GradientCache): void {
  const { verbs, points, fill, stroke } = cmd;
  ctx.beginPath();
  let p = 0; // point index
  for (const verb of verbs) {
    if (verb === PathVerb.Move) {
      ctx.moveTo(points[p * 2], points[p * 2 + 1]);
      p++;
    } else if (verb === PathVerb.Line) {
      ctx.lineTo(points[p * 2], points[p * 2 + 1]);
      p++;
    } else {
      ctx.closePath();
    }
  }
  if (fill !== undefined) {
    ctx.fillStyle = cache.resolve(fill, ctx);
    ctx.fill(); // nonzero winding (the default)
  }
  if (stroke !== undefined) {
    applyStroke(ctx, stroke, cache);
    ctx.stroke();
  }
}

function drawText(ctx: CanvasRenderingContext2D, cmd: TextCommand): void {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  let lastFont: TextCommand['items'][number]['font'] | undefined;
  for (const item of cmd.items) {
    if (item.font !== lastFont) {
      ctx.font = fontString(item.font); // reference compare: skip redundant font writes
      lastFont = item.font;
    }
    ctx.fillStyle = item.color;
    ctx.fillText(item.text, item.x, item.y);
  }
}

function drawImage(ctx: CanvasRenderingContext2D, cmd: ImageCommand): void {
  const handle = cmd.image as CanvasImageHandle;
  const { src, dst } = cmd;
  const alpha = cmd.alpha ?? 1;
  assert(alpha >= 0 && alpha <= 1, 'image alpha must be in [0,1]');
  const prev = ctx.globalAlpha;
  if (alpha !== 1) ctx.globalAlpha = alpha;
  ctx.drawImage(handle.source, src.x, src.y, src.width, src.height, dst.x, dst.y, dst.width, dst.height);
  if (alpha !== 1) ctx.globalAlpha = prev;
}
