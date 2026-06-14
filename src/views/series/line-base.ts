// views/series/line-base.ts — the SHARED line geometry + hit scaffold (study 06
// §4.4 walkLine / §4.12 line-based hit; design 03 §8.5.1). Line, Area, and Baseline
// all draw the same polyline topology, so the walkLine state machine, the
// Catmull-Rom flatten, the point→segment / point→curve distance helpers, the
// single-point stub, the marker-circles emit, and the line-based hitTest live HERE
// once. Callers pass MEDIA-space lanes (the buffer's converted x/y) + a per-index
// colour getter + resolved style; walkLine's vertex/gap callbacks receive DEVICE-px
// coords (the caller already chose to scale by hr/vr exactly where line.ts does).
// hit helpers stay in MEDIA px; the curve flatten takes hr/vr only to size segments
// from the device-px chord, identical to emit.
import { lowerBound } from '../../core';
import { HitPriority } from '../../gfx';
import type { CirclesWriter } from '../../gfx';
import type { HitCandidate } from '../../gfx';

/** The three line topologies (study 06 §4.4). Shared by line/area/baseline. */
export const LineType = {
  Simple: 0,
  WithSteps: 1,
  Curved: 2,
} as const;
export type LineType = (typeof LineType)[keyof typeof LineType];

/** Curved-segment clamp bounds + tension (study 06 §4.4 / design 03 §8.5.1). */
const CURVE_MIN_SEGMENTS = 4;
const CURVE_MAX_SEGMENTS = 24;
const CURVE_TENSION = 6;

/** clamp(ceil(chordPx / 2), 4, 24) — adaptive curve subdivision (design 03 §8.5.1). */
export function curveSegments(chordPx: number): number {
  const n = Math.ceil(chordPx / 2);
  return n < CURVE_MIN_SEGMENTS ? CURVE_MIN_SEGMENTS : n > CURVE_MAX_SEGMENTS ? CURVE_MAX_SEGMENTS : n;
}

/** Catmull-Rom control point 1 for the segment leaving index `i` (study 06 §4.4):
 *  clamps neighbour indices to bounds. Returns the cp coordinate on one axis. */
export function cp1(p: Float32Array, i: number, last: number): number {
  const prev = i - 1 < 0 ? 0 : i - 1;
  const next = i + 1 > last ? last : i + 1;
  return p[i]! + (p[next]! - p[prev]!) / CURVE_TENSION;
}
/** Catmull-Rom control point 2 for the segment arriving at index `i+1`. */
export function cp2(p: Float32Array, i: number, last: number): number {
  const after = i + 2 > last ? last : i + 2;
  const next = i + 1 > last ? last : i + 1;
  return p[next]! - (p[after]! - p[i]!) / CURVE_TENSION;
}

/** Cubic Bézier evaluation at parameter t∈[0,1]. */
export function bezier(p0: number, c1: number, c2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3;
}

/** Point→segment distance (clamped projection t∈[0,1]), media px (study 06 §4.12). */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Distance from (px,py) to the flattened Curved segment leaving index `i` — the
 *  IDENTICAL flatten emit drew (same control points; segment count from the
 *  device-px chord using hr/vr). All distances in media px (study 06 §4.12). */
export function distToCurveSegment(
  xs: Float32Array,
  ys: Float32Array,
  i: number,
  last: number,
  hr: number,
  vr: number,
  px: number,
  py: number,
): number {
  const ax = xs[i]!;
  const ay = ys[i]!;
  const bx = xs[i + 1]!;
  const by = ys[i + 1]!;
  const c1x = cp1(xs, i, last);
  const c1y = cp1(ys, i, last);
  const c2x = cp2(xs, i, last);
  const c2y = cp2(ys, i, last);
  const chordPx = Math.hypot((bx - ax) * hr, (by - ay) * vr);
  const segs = curveSegments(chordPx);
  let best = Number.POSITIVE_INFINITY;
  let prevX = ax;
  let prevY = ay;
  for (let s = 1; s <= segs; s++) {
    const t = s / segs;
    const cx = bezier(ax, c1x, c2x, bx, t);
    const cy = bezier(ay, c1y, c2y, by, t);
    const d = distToSegment(px, py, prevX, prevY, cx, cy);
    if (d < best) best = d;
    prevX = cx;
    prevY = cy;
  }
  return best;
}

/** Per-index colour getter (line/area read different colour lanes); index → CSS colour. */
export type ColorAt = (i: number) => string;

/**
 * Walk the visible items `[from, to)` into polyline vertices per the line type,
 * applying the segment-styling rule via per-vertex colour (design 03 §3.2.2 /
 * §8.5.1; the reference's walkLine, study 06 §4.4). `vertex`/`gap` receive DEVICE-px
 * coordinates (lanes are media px; this multiplies by hr/vr). Single visible point →
 * a horizontal stub of one bar width, centred (study 06 §4.4).
 */
export function walkLine(
  xs: Float32Array,
  ys: Float32Array,
  colorAt: ColorAt,
  from: number,
  to: number,
  hr: number,
  vr: number,
  barSpacing: number,
  type: LineType,
  vertex: (x: number, y: number, fill: string) => void,
  gap: () => void,
): void {
  const count = to - from;
  if (count === 1) {
    const i = from;
    const yi = ys[i]!;
    if (Number.isNaN(yi)) return;
    const fill = colorAt(i);
    const cx = xs[i]! * hr;
    const cy = yi * vr;
    const half = (barSpacing / 2) * hr;
    vertex(cx - half, cy, fill);
    vertex(cx + half, cy, fill);
    return;
  }
  const last = to - 1;
  let penDown = false;
  for (let i = from; i < to; i++) {
    const yi = ys[i]!;
    if (Number.isNaN(yi)) {
      if (penDown) {
        gap();
        penDown = false;
      }
      continue;
    }
    const fill = colorAt(i);
    const cx = xs[i]! * hr;
    const cy = yi * vr;
    if (!penDown) {
      vertex(cx, cy, fill); // anchor of a (sub-)path in its own colour
      penDown = true;
      continue;
    }
    const prevY = ys[i - 1]!;
    const prevX = xs[i - 1]!;
    const prevColor = colorAt(i - 1);
    if (type === LineType.WithSteps && !Number.isNaN(prevY)) {
      // riser corner (curX, prevY) carries the NEW colour: horizontal draws OLD, the
      // riser (curX,prevY)→(curX,curY) draws NEW (design 03 §8.5.1).
      vertex(cx, prevY * vr, fill);
      vertex(cx, cy, fill);
    } else if (type === LineType.Curved && !Number.isNaN(prevY)) {
      // flatten the Catmull-Rom segment (prev → cur); intermediate verts carry prev's
      // colour (segment draws OLD), the endpoint carries cur's (begins next, §4.4).
      const c1x = cp1(xs, i - 1, last);
      const c1y = cp1(ys, i - 1, last);
      const c2x = cp2(xs, i - 1, last);
      const c2y = cp2(ys, i - 1, last);
      const chordPx = Math.hypot((xs[i]! - prevX) * hr, (yi - prevY) * vr);
      const segs = curveSegments(chordPx);
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        vertex(bezier(prevX, c1x, c2x, xs[i]!, t) * hr, bezier(prevY, c1y, c2y, yi, t) * vr, prevColor);
      }
      vertex(cx, cy, fill);
    } else {
      vertex(cx, cy, fill); // Simple (or a step/curve after a gap → straight join)
    }
  }
}

/** Emit the point-marker circles (study 06 §4.5): one circles command, back-to-front
 *  (reverse order so left points overdraw), x rounded with the tickWidth-parity
 *  correction, y/r unrounded ×vr. `radius` is the resolved marker radius (media px). */
export function emitMarkers(
  circ: CirclesWriter,
  xs: Float32Array,
  ys: Float32Array,
  colorAt: ColorAt,
  from: number,
  to: number,
  hr: number,
  vr: number,
  radius: number,
): void {
  for (let i = to - 1; i >= from; i--) {
    const y = ys[i]!;
    if (Number.isNaN(y)) continue;
    const tickWidth = Math.max(1, Math.floor(hr));
    const correction = (tickWidth % 2) / 2;
    circ.circle(Math.round(xs[i]! * hr) + correction, y * vr, radius * vr + correction, colorAt(i));
  }
}

/** Resolved line-based hit parameters (study 06 §4.12). Media px throughout. */
export interface LineHitParams {
  /** Line topology (Simple / WithSteps / Curved). */
  readonly type: LineType;
  /** Stroke half-width: lineWidth/2 if visible, else 0.5 (line treated as width 1). */
  readonly lineHalf: number;
  /** Resolved point-marker radius, or undefined when markers are hidden. */
  readonly markerRadius: number | undefined;
  /** Hit-test tolerance (default 3). */
  readonly tolerance: number;
  /** Bar spacing this frame (single-point stub half-width). */
  readonly barSpacing: number;
  /** hr/vr captured at the last convert (sizes the curve flatten = emit's). */
  readonly hr: number;
  readonly vr: number;
}

/**
 * Line-based hit test over the converted slice `[from, to)` (study 06 §4.12):
 * point-marker pass (Point priority) beats the line; single-point stub pass (Point);
 * then segment-distance pass (Line priority) per line type. Returns the best
 * `HitCandidate` or null. Operates in MEDIA px on the lanes emit drew.
 */
export function hitTestLine(
  xs: Float32Array,
  ys: Float32Array,
  from: number,
  to: number,
  px: number,
  py: number,
  p: LineHitParams,
): HitCandidate | null {
  const count = to - from;
  if (count === 0) return null;
  const r = p.markerRadius;
  const radius = Math.max(p.lineHalf, r ?? 0) + p.tolerance;
  const last = to - 1;

  // --- point markers (Point priority) win over the line ---
  if (r !== undefined) {
    let best = Number.POSITIVE_INFINITY;
    const lo = lowerBound(xs, px - radius, (a, v) => (a as number) < (v as number), from, to);
    for (let i = lo; i < to; i++) {
      const ix = xs[i]!;
      if (ix > px + radius) break;
      const iy = ys[i]!;
      if (Number.isNaN(iy)) continue;
      const dx = px - ix;
      const dy = py - iy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r + p.tolerance && d < best) best = d;
    }
    if (best !== Number.POSITIVE_INFINITY) return { distance: best, priority: HitPriority.Point };
  }

  // --- single visible point: horizontal stub of half-width max(barSpacing/2, radius) ---
  if (count === 1) {
    const ix = xs[from]!;
    const iy = ys[from]!;
    if (Number.isNaN(iy)) return null;
    const half = Math.max(p.barSpacing / 2, radius);
    if (px >= ix - half && px <= ix + half && Math.abs(py - iy) <= radius) {
      return { distance: Math.abs(py - iy), priority: HitPriority.Point };
    }
    return null;
  }

  // --- segments: candidate window by x, distance per line type ---
  let best = Number.POSITIVE_INFINITY;
  const searchHalf = radius + p.barSpacing; // a curve can bow out by its control polygon
  const lo = lowerBound(xs, px - searchHalf, (a, v) => (a as number) < (v as number), from, to);
  for (let i = lo > from ? lo - 1 : from; i < last; i++) {
    const ax = xs[i]!;
    if (ax - searchHalf > px) break;
    const ay = ys[i]!;
    const bx = xs[i + 1]!;
    const by = ys[i + 1]!;
    if (Number.isNaN(ay) || Number.isNaN(by)) continue; // gap — no segment
    let d: number;
    if (p.type === LineType.WithSteps) {
      const dh = distToSegment(px, py, ax, ay, bx, ay);
      const dv = distToSegment(px, py, bx, ay, bx, by);
      d = dh < dv ? dh : dv;
    } else if (p.type === LineType.Curved) {
      d = distToCurveSegment(xs, ys, i, last, p.hr, p.vr, px, py);
    } else {
      d = distToSegment(px, py, ax, ay, bx, by);
    }
    if (d < best) best = d;
  }
  if (best <= radius) return { distance: best, priority: HitPriority.Line };
  return null;
}
