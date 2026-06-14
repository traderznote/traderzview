// views/axis-layout.ts — pure axis layout (design 01 §5.4 / §13.6). The model owns
// axis MARKS (positions + strings); LAYOUT (optimal width/height, edge align, width
// ratchet) is a pure `views` fn. layoutPriceAxis measures first/last tick labels +
// every non-fixed back-label + two synthetic crosshair samples (study 04 §3.7);
// fixedCoordinate labels are excluded from width AND aligner. layoutTimeAxis derives
// optimal height + the max-weight bold pass (Hour1 quirk) + inward edge shift (study
// 03 §4.13/§4.14). AxisWidthRatchet quantises growth to 8 px and shrinks only after
// 30 consecutive ≥8 px-slack frames (§13.6 hysteresis).
import type { FontSpec, ITextMeasurer } from '../gfx';
import type { AxisLabel } from '../model';

const evenCeil = (n: number): number => {
  const c = Math.ceil(n);
  return c % 2 === 0 ? c : c + 1;
};

// --- price axis (study 04 §3.7 / design 01 §5.4) --------------------------------

const PRICE_FALLBACK_WIDTH = 34; // width when nothing measured (study 04 §3.7)
const CROSSHAIR_DIGITS = 0.11111111111111; // digit-heavy reservation (study 04 §3.7)

/** A tick label — only its width matters (position is the model's). */
export interface PriceTickLabel {
  readonly text: string;
}

/** The two 1-px-inside sample prices for the crosshair reservation (study 04 §3.7).
 *  `null` skips it (crosshair off or no first value). */
export interface CrosshairSample {
  readonly topValue: number; // coordinateToPrice(y = 1)
  readonly bottomValue: number; // coordinateToPrice(y = height − 2)
  readonly format: (price: number) => string;
}

export interface PriceAxisInput {
  readonly ticks: readonly PriceTickLabel[]; // ordered; only first + last measured
  readonly backLabels: readonly AxisLabel[]; // series last-value + price-line + primitive
  readonly crosshair: CrosshairSample | null;
  readonly font: FontSpec;
  readonly minimumWidth?: number;
}

/** A laid-out back-label: measured width + Y (the FIXED coordinate when pinned). */
export interface PriceLabelPlacement {
  readonly text: string;
  readonly y: number;
  readonly width: number;
  readonly fixed: boolean; // fixedCoordinate pill: render pinned, never aligned
}

export interface PriceAxisLayout {
  readonly maxLabelWidth: number; // measured content width (pre-chrome, pre-ratchet)
  readonly width: number; // desired width incl. chrome, even, ≥ minimumWidth
  readonly labels: readonly PriceLabelPlacement[];
}

/** Optimal price-axis layout (study 04 §3.7). Width = chrome + max over first/last
 *  tick labels, every non-fixed back-label, and the two crosshair samples; a
 *  fixedCoordinate label is excluded from width and the aligner (it carries
 *  `fixed: true` and its pinned y). Then add chrome and round up to even. */
export function layoutPriceAxis(input: PriceAxisInput, m: ITextMeasurer): PriceAxisLayout {
  const { ticks, backLabels, crosshair, font } = input;
  const measure = (t: string): number => (t.length === 0 ? 0 : m.measure(t, font).width);
  let max = 0;

  if (ticks.length > 0) max = Math.max(measure(ticks[0]!.text), measure(ticks[ticks.length - 1]!.text));

  const labels: PriceLabelPlacement[] = [];
  for (const l of backLabels) {
    if (l.visible && l.visible() === false) continue;
    const fixedAt = l.fixedCoordinate?.();
    const fixed = fixedAt !== undefined;
    const width = measure(l.text());
    if (!fixed) max = Math.max(max, width); // pinned labels do NOT widen the axis
    labels.push({ text: l.text(), y: fixed ? (fixedAt as number) : l.coordinate(), width, fixed });
  }

  if (crosshair !== null) {
    const lo = Math.min(crosshair.topValue, crosshair.bottomValue);
    const hi = Math.max(crosshair.topValue, crosshair.bottomValue);
    max = Math.max(
      max,
      measure(crosshair.format(Math.floor(lo) + CROSSHAIR_DIGITS)),
      measure(crosshair.format(Math.ceil(hi) - CROSSHAIR_DIGITS)),
    );
  }

  // chrome = border(1) + tickLen(5) + paddingInner + paddingOuter + labelOffset(5);
  // paddingInner = paddingOuter = fontSize/12 · 5 (study 04 §3.7).
  const pad = (font.size / 12) * 5;
  let width = max === 0 ? PRICE_FALLBACK_WIDTH : evenCeil(1 + 5 + 2 * pad + 5 + max);
  if (input.minimumWidth !== undefined) width = Math.max(width, input.minimumWidth);
  return { maxLabelWidth: max, width, labels };
}

// --- the axis-width ratchet (design 01 §13.6) -----------------------------------

const RATCHET_STEP = 8; // growth quantum, also the slack threshold (px)
const SHRINK_FRAMES = 30; // consecutive ≥STEP-slack frames before a shrink
const quantize = (w: number): number => Math.ceil(w / RATCHET_STEP) * RATCHET_STEP;

/**
 * Grow-only-with-hysteresis axis-width ratchet (§13.6). Growth is quantised to 8 px
 * and applied immediately (the reference's `<`-not-`!=` guard, kept). Shrink happens
 * only after 30 CONSECUTIVE frames whose slack (current − desired) is ≥ 8 px; one
 * sub-threshold frame resets the run, so a transient narrow frame never collapses it.
 */
export class AxisWidthRatchet {
  #width = 0;
  #slackFrames = 0;

  get width(): number {
    return this.#width;
  }

  /** Feed this frame's desired width; returns the new ratcheted width. */
  update(desired: number): number {
    if (desired > this.#width) {
      this.#width = quantize(desired); // grow up to the next 8-px step, immediately
      this.#slackFrames = 0;
    } else if (this.#width - desired >= RATCHET_STEP) {
      if (++this.#slackFrames >= SHRINK_FRAMES) {
        this.#width = quantize(desired);
        this.#slackFrames = 0;
      }
    } else {
      this.#slackFrames = 0; // not enough slack this frame → reset the run
    }
    return this.#width;
  }

  reset(): void {
    this.#width = 0;
    this.#slackFrames = 0;
  }
}

// --- time axis (study 03 §4.13/§4.14 / design 01 §5.4) --------------------------

const WEIGHT_HOUR1 = 30; // study 03 weight table
const WEIGHT_DAY = 50;

/** A time-axis tick to lay out: `coordinate` = media-px tick X; `weight` drives the
 *  bold pass; `needAlign` = an edge label that may be shifted inward. */
export interface TimeMarkInput {
  readonly coordinate: number;
  readonly label: string;
  readonly weight: number;
  readonly needAlign: boolean;
}

export interface TimeAxisInput {
  readonly marks: readonly TimeMarkInput[];
  readonly font: FontSpec;
  readonly width: number; // axis surface media width (edge-clip bound)
  readonly minimumHeight?: number;
  readonly allowBoldLabels?: boolean; // default true
}

/** A placed time label: left edge `x` (post inward shift), unclamped tick `center`,
 *  and whether it is drawn bold (max-weight pass; host draws bold last). */
export interface TimeLabelPlacement {
  readonly x: number;
  readonly center: number;
  readonly text: string;
  readonly bold: boolean;
}

export interface TimeAxisLayout {
  readonly height: number; // optimal axis height, even, ≥ minimumHeight
  readonly labels: readonly TimeLabelPlacement[];
}

/** Bold weight class (study 03 §4.13): the max visible weight, with the Hour1 quirk —
 *  a max strictly between Hour1 (30) and Day (50) drops to 30 so 15:00 isn't lone-
 *  bolded. `null` when there are no marks. */
export function boldWeight(marks: readonly TimeMarkInput[]): number | null {
  if (marks.length === 0) return null;
  let max = marks[0]!.weight;
  for (let i = 1; i < marks.length; i++) if (marks[i]!.weight > max) max = marks[i]!.weight;
  return max > WEIGHT_HOUR1 && max < WEIGHT_DAY ? WEIGHT_HOUR1 : max;
}

/** Time-axis layout (study 03 §4.14 geometry / §4.13 bold + edge align). Height =
 *  ceil(border1 + tickLen5 + F + padTop + padBottom + labelBottomOffset), even, maxed
 *  with minimumHeight (padTop=padBottom=3F/12, labelBottomOffset=4F/12). Each label is
 *  centred on its tick; a needAlign edge label shifts INWARD into [0, width]. */
export function layoutTimeAxis(input: TimeAxisInput, m: ITextMeasurer): TimeAxisLayout {
  const F = input.font.size;
  let height = evenCeil(1 + 5 + F + (3 * F) / 12 + (3 * F) / 12 + (4 * F) / 12);
  if (input.minimumHeight !== undefined) height = Math.max(height, evenCeil(input.minimumHeight));

  const maxW = (input.allowBoldLabels ?? true) ? boldWeight(input.marks) : null;
  const labels: TimeLabelPlacement[] = [];
  for (const mark of input.marks) {
    const half = mark.label.length === 0 ? 0 : m.measure(mark.label, input.font).width / 2;
    let x = mark.coordinate - half; // centred on the tick
    if (mark.needAlign) {
      if (x < 0) x = 0; // left edge inward to 0
      if (x + 2 * half > input.width) x = input.width - 2 * half; // right edge inward
    }
    labels.push({ x, center: mark.coordinate, text: mark.label, bold: maxW !== null && mark.weight >= maxW });
  }
  return { height, labels };
}
