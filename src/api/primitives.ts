// traderzview · api — the PUBLIC primitive seam (design 02 §12). The api owns the
// public `.d.ts` shapes plugins implement against: the lifecycle-bearing `IPrimitive`,
// the `PrimitiveContext` handed to `attached()`, and the gfx `ImageHandle` re-export.
// The model `IPrimitive` is a SUBSET (model hooks only, no host lifecycle, §3.1); a
// primitive built here stays assignable to attachPrimitive (extra members optional).
import type { ImageHandle } from '../gfx';
import type { AutoscaleInfo, AxisLabel, PrimitiveSource } from '../model';
import type { Time } from '../data';
import type { IInteractionRouter } from '../host';
import type { IChart, IPane } from './chart';
import type { ISeries, LogicalRange } from './series';
import type { SeriesType } from './series-defs';

export type { AutoscaleInfo, AxisLabel, PrimitiveSource, ImageHandle };

/**
 * One interface for series- and pane-attached primitives (design 02 §12). Every member
 * optional — `{}` is a valid primitive. The lifecycle pair (`attached`/`detached`) is the
 * host-driven extension over the model `IPrimitive`; design 05 §2.2 fixes its guarantees.
 */
export interface IPrimitive<H = Time> {
  attached?(ctx: PrimitiveContext<H>): void;
  detached?(): void;
  /** Scene sources to register; polled at attach + after `requestUpdate('layout')`. */
  sources?(): readonly PrimitiveSource[];
  /** Auto-placed axis labels (overlap-shifted like series labels). */
  priceAxisLabels?(): readonly AxisLabel[];
  timeAxisLabels?(): readonly AxisLabel[];
  /** Extra range + MAX-merged margins for autoscale. Series-attached only; per frame. */
  autoscale?(range: LogicalRange): AutoscaleInfo | null;
}

/**
 * The context `attached(ctx)` receives (design 02 §12). `series` is present iff series-
 * attached; `requestUpdate(scope)` maps onto the §4.4 UpdateLevel (only `'layout'` re-
 * polls `sources()`); `images` is the sole backend image-upload path (architecture §5.2).
 */
export interface PrimitiveContext<H = Time> {
  chart: IChart<H>;
  series?: ISeries<SeriesType, H>;
  pane: IPane<H>;
  requestUpdate(scope: 'overlay' | 'render' | 'layout'): void;
  input: IInteractionRouter;
  images: { create(src: unknown): ImageHandle };
}
