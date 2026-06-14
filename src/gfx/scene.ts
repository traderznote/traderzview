// The one z-band scene model (architecture §6). Series, grid, crosshair,
// primitives, indicators, and drawing tools all register SceneSources into the
// same bands. These are gfx types (gfx imports only core), so extras/primitives
// implement SceneSource without touching views internals. The registry (PaneScene)
// and the host pairing live in views/host respectively.
import type { Coordinate } from '../core';
import type { FrameInfo } from './backend';
import type { DisplayList } from './commands';
import type { HitCandidate } from './hit';

// erasable const-object (enum forbidden by erasableSyntaxOnly). Bands 0-5 are the
// base layer; 6-8 the overlay layer.
export const ZBand = {
  Background: 0,
  Grid: 1,
  BelowSeries: 2,
  Series: 3,
  AboveSeries: 4,
  Labels: 5,
  Crosshair: 6,
  OverlayLabels: 7,
  Cursor: 8,
} as const;
export type ZBand = (typeof ZBand)[keyof typeof ZBand];

export interface ViewFrame {
  readonly frame: FrameInfo; // surface media/bitmap sizes + hr/vr (§5.2)
  readonly now: number; // frame timestamp, drives animations
}

export interface SceneSource {
  readonly zBand: ZBand; // one band per source; an owner registers several sources
  update(frame: ViewFrame): void; // make-valid; cheap when not dirty
  displayLists(): readonly DisplayList[]; // CACHED until dirtied; drawn in array order
  hitTest?(x: Coordinate, y: Coordinate, frame: ViewFrame): HitCandidate | null;
}
