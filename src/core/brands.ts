// Branded (nominal) numeric types and the shared geometry primitives
// (architecture §4.2). Zero runtime cost — a phantom symbol prevents mixing
// units that are all `number` at runtime (a Coordinate is not a BarPrice).
//
// Size, Rect, and CursorStyle live HERE, in core, not in gfx — so the headless
// model can name shared geometry without importing gfx (the §4.2 / §5.5 rule that
// makes "HoverTarget is core types only" literally true).

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Coordinate = Brand<number, 'Coordinate'>; // media px
export type BitmapCoordinate = Brand<number, 'BitmapCoordinate'>; // device px
export type TimeIndex = Brand<number, 'TimeIndex'>; // slot on the union timeline
export type Logical = Brand<number, 'Logical'>; // fractional bar position
export type HorzKey = Brand<number, 'HorzKey'>; // behavior ordering key
export type BarPrice = Brand<number, 'BarPrice'>;

/** A CSS cursor keyword ('default' | 'pointer' | 'crosshair' | …). A string in
 *  core — NOT a gfx type — so model and gfx can refer to the same `cursor` type. */
export type CursorStyle = string;

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
