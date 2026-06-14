// Canvas-free hit testing (architecture §5.5). Sources hit-test over the same
// coordinate arrays they emit, so hit geometry and drawn geometry never disagree.
// Arbitration (kept verbatim): Point beats non-Point; else min distance; equal
// distance keeps source z-order. One rule set for series, primitives, and tools.
import type { CursorStyle } from '../core';

// erasable const-object (enum forbidden by erasableSyntaxOnly).
export const HitPriority = {
  Range: 0,
  Line: 1,
  Point: 2,
} as const;
export type HitPriority = (typeof HitPriority)[keyof typeof HitPriority];

export interface HitCandidate {
  distance: number; // media px; required (no implicit 0)
  priority: HitPriority;
  cursor?: CursorStyle; // CursorStyle is a `core` type (§4.2), not a gfx one
  externalId?: string;
  data?: unknown; // echoed to the source on hover/draw
}
