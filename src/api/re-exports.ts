// traderzview · api — the design 02 §3.2 engine/gfx/seam re-exports. These names are
// OWNED by sibling modules (gfx per design 03; the views/data engine helpers per
// architecture 01 §6/§4.5/§9.2; the host input + scheduler seam per §13.5/§13.6) and
// surfaced here verbatim so the package root is complete (§3.2 / §19). `api` re-exports
// them; it never re-specifies their members. Type-only where the name is a type.

// --- gfx re-exports (the backend seam, design 03) ----------------------------------
export type {
  SceneSource,
  ViewFrame,
  HitCandidate,
  DisplayList,
  IRenderBackend,
  Snapshot,
} from '../gfx';
export { ZBand, DisplayListBuilder } from '../gfx';

// --- engine helpers (views/data, architecture 01 §6/§4.5/§9.2) ---------------------
export type { SeriesKind, ItemBuffer, ItemWindow } from '../views';
export type { SeriesDataContract, PlotStoreView, StoreDiff } from '../data';
export type { HorzGeometry, PriceConverter } from '../model';

// --- behavior + data seam (design 02 §13.1/§13.3) ----------------------------------
export type {
  IHorzScaleBehavior,
  HorzPoint,
  Time,
  UTCTimestamp,
  BusinessDay,
} from '../data';
export type {
  TimeScaleOptions,
  LocalizationOptions,
  HorzScaleOptionGroups,
  TimeScaleFormatOptions,
} from '../data';

// --- the option groups owned by model (design 02 §6) -------------------------------
export type {
  ChartOptions,
  LayoutOptions,
  GridOptions,
  CrosshairOptions,
  PriceScaleOptions,
} from '../model';

// --- primitives + autoscale seam (design 02 §12 / §13.4) ---------------------------
// The PUBLIC primitive shapes are owned by ./primitives (the lifecycle-bearing
// IPrimitive + PrimitiveContext + ImageHandle, §12); AxisLabel/AutoscaleInfo/
// PrimitiveSource keep their model field-level shapes, re-exported through there.
export type {
  IPrimitive,
  PrimitiveContext,
  PrimitiveSource,
  AxisLabel,
  AutoscaleInfo,
  ImageHandle,
} from './primitives';

// --- the interaction router + gesture types (design 02 §13.5) ----------------------
export type {
  IInteractionRouter,
  GestureRegistration,
  GestureEvent,
  GestureResponse,
  GestureKind,
  GesturePhase,
  SurfaceKind,
} from '../host';

// --- the frame scheduler seam (design 02 §13.6) ------------------------------------
export type { IFrameScheduler, FrameCallback } from '../host';
