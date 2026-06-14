// The draw-command vocabulary (design 03 §3). Plain data only — views produce
// these, backends consume them, nothing else crosses the seam. All geometry is in
// "list space" (bitmap lists carry device px already crisp-rounded; media lists
// carry CSS px the backend scales by (hr, vr)). All coordinate payloads are
// Float32Array (geometry never needs float64; halves GPU upload size).
import type { Disposable, Rect, Size } from '../core';

// Re-exported through the seam so views/backends name geometry from gfx, while the
// type itself lives in core (architecture §4.2 — so the headless model can use it).
export type { Rect };

export type Space = 'media' | 'bitmap';

export interface DisplayList {
  readonly space: Space;
  readonly clip?: Rect; // ALWAYS media px, even for bitmap lists (a layout concept)
  readonly commands: readonly DrawCommand[];
}

export type FillStyle = string /* CSS color */ | LinearGradientY;

export interface LinearGradientY {
  readonly from: number; // y in LIST space
  readonly to: number; // y in LIST space
  // offset ∈ [0,1] ascending; two stops at one offset = hard split (Baseline).
  readonly stops: readonly { readonly offset: number; readonly color: string }[];
}

export interface StyleRun {
  readonly count: number;
  readonly fill: FillStyle;
}

// design 03 sketches LineStyle/PathVerb as `enum`/`const enum`, but the M0-locked
// erasableSyntaxOnly flag forbids enums. These const-objects + unions are the
// erasable equivalent: identical `LineStyle.Dashed` / `PathVerb.Move` member access,
// zero runtime enum. (Flagged deviation; same semantics.)
export const LineStyle = {
  Solid: 0,
  Dotted: 1,
  Dashed: 2,
  LargeDashed: 3,
  SparseDotted: 4,
} as const;
export type LineStyle = (typeof LineStyle)[keyof typeof LineStyle];

/** Dash segments (study 05 §4.4) as multiples of the line width `w`. */
export function dashPattern(style: LineStyle, w: number): number[] {
  switch (style) {
    case LineStyle.Dotted:
      return [w, w];
    case LineStyle.Dashed:
      return [2 * w, 2 * w];
    case LineStyle.LargeDashed:
      return [6 * w, 6 * w];
    case LineStyle.SparseDotted:
      return [w, 4 * w];
    default:
      return []; // Solid
  }
}

export interface FontSpec {
  readonly family: string; // CSS font-family list
  readonly size: number; // CSS px (media)
  readonly weight?: 'normal' | 'bold' | number;
  readonly style?: 'normal' | 'italic';
}

export interface StrokeSpec {
  readonly width: number; // list-space units
  readonly color: FillStyle;
  readonly style?: LineStyle; // default Solid
}

export const PathVerb = {
  Move: 0,
  Line: 1,
  Close: 2,
} as const;
export type PathVerb = (typeof PathVerb)[keyof typeof PathVerb];

// Opaque, backend-created, sized, disposable (01 §5.1/§5.2). The TYPE lives here
// (rather than backend.ts) so ImageCommand can carry it without a commands<->backend
// import cycle; only the backend constructs one. (Flagged: §5.2 lists it under the
// backend; moved here at field-level per 03 §11 to keep the seam acyclic.)
export interface ImageHandle extends Disposable {
  readonly size: Size;
}

export interface TextItem {
  readonly x: number; // media px; LEFT edge of the run
  readonly y: number; // media px; alphabetic BASELINE
  readonly text: string;
  readonly font: FontSpec;
  readonly color: string; // CSS color (no gradients on text in v1)
}

export interface RectsCommand {
  readonly kind: 'rects';
  readonly coords: Float32Array; // x,y,w,h quads; length = 4·N; w,h ≥ 0
  readonly runs: readonly StyleRun[]; // Σ count = N
  readonly radius?: number; // uniform corner radius for ALL quads
  readonly stroke?: StrokeSpec; // uniform outline for ALL quads, after fills
}

export interface PolylineCommand {
  readonly kind: 'polyline';
  readonly points: Float32Array; // x,y pairs; (NaN, NaN) = pen-up gap
  readonly runs: readonly StyleRun[]; // Σ count = vertex count (incl. gaps)
  readonly width: number;
  readonly style: LineStyle;
  readonly join: 'round' | 'miter'; // cap is always 'butt'
}

export interface AreaCommand {
  readonly kind: 'area';
  readonly points: Float32Array; // top-edge polyline; NaN pair = gap
  readonly baseY: number; // list-space y the polygon closes to
  readonly fill: FillStyle;
}

export interface CirclesCommand {
  readonly kind: 'circles';
  readonly coords: Float32Array; // x,y,r triples; length = 3·N
  readonly runs: readonly StyleRun[]; // Σ count = N; EMPTY runs = no fill
  readonly stroke?: StrokeSpec; // uniform ring stroke for ALL circles, after fills
}

export interface PathCommand {
  readonly kind: 'path';
  readonly verbs: Uint8Array; // PathVerb sequence
  readonly points: Float32Array; // x,y pairs consumed by Move/Line
  readonly fill?: FillStyle; // nonzero winding
  readonly stroke?: StrokeSpec;
}

export interface TextCommand {
  readonly kind: 'text';
  readonly items: readonly TextItem[];
}

export interface ImageCommand {
  readonly kind: 'image';
  readonly image: ImageHandle;
  readonly src: Rect; // source rect in image pixels
  readonly dst: Rect; // destination rect in LIST space
  readonly alpha?: number; // 0..1, default 1
}

export type DrawCommand =
  | RectsCommand
  | PolylineCommand
  | AreaCommand
  | CirclesCommand
  | PathCommand
  | TextCommand
  | ImageCommand;
