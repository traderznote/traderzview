// The time-axis interaction state machine (architecture §4.6 / §4.4; study 03
// §4.5/§4.6/§4.8, study 01 §4.4, study 07 §4.11 are the spec of record). Pure
// state + math — no model reference, no DOM. It owns:
//   • the HorzScaleCommand algebra + `reduceHorzCommands` reducer (the replace-vs-
//     append-vs-cancel laws, architecture §4.4);
//   • bar-spacing and right-offset clamps (study 03 §4.5/§4.6);
//   • the right-offset compensation three-flag follow/stay rule (study 01 §4.4);
//   • `createKineticAnimation` closed-form exponential decay (study 07 §4.11) with
//     the §13.13 ε/barSpacing FIX (ε is one *pixel* of residual travel, not one bar);
//   • `rightOffsetPixels` px↔bars normalization at the one boundary (design 02 §5.3.4).
//
// Gesture *recognition* (which pointer events become a scroll/zoom/fling) lives in
// `host/input`, §7 — this file holds only the resulting state transitions + math.
import type { LogicalRange } from './geometry';

// MinVisibleBarsCount: at least this many bars (or all, if fewer) stay visible at
// either scroll extreme (study 03 §4.6). The 0.5·W max-spacing coefficient is
// deliberately tied to it (1/2 ≥ 0.5; study 03 §4.5/§5).
const MIN_VISIBLE_BARS = 2;
const MAX_SPACING_COEFF = 0.5;

// ---------------------------------------------------------------------------
// HorzAnimation + the kinetic closed form (architecture §4.4, study 07 §4.11).
// ---------------------------------------------------------------------------

/** A model-owned immutable animation value (architecture §4.4). Stateless per
 *  frame: the scheduler samples `positionAt(now)` until `finished(now)`. */
export interface HorzAnimation {
  finished(now: number): boolean;
  positionAt(now: number): number;
}

/** The closed-form decay parameters `createKineticAnimation` consumes. ε is
 *  already barSpacing-scaled by the caller (the §13.13 FIX). */
export interface KineticTuning {
  /** Damping coefficient per ms (D, dimensionless). */
  readonly damping: number;
  /** Stop threshold in right-offset units (bars). = epsilonPx / barSpacing. */
  readonly epsilon: number;
}

/** The named kinetic constants — the spec of record (design 04 §7, study 07
 *  §4.11). Pixel-denominated; `host/input`'s velocity tracker divides the speed
 *  trio by barSpacing at fling start, and `kineticTuningForBarSpacing` divides ε. */
export const KINETIC = {
  /** Min launch speed, px/ms — below this no fling. */
  minSpeed: 0.2,
  /** Max segment speed clamp, px/ms. */
  maxSpeed: 7,
  /** Damping coefficient D per ms. */
  damping: 0.997,
  /** Jitter filter: samples moving < this many px are dropped. */
  minMove: 15,
  /** A fling launches only if released within this many ms of the last sample. */
  maxStartDelay: 50,
  /** Residual-travel stop threshold, in *pixels* (the §13.13 FIX divides by S). */
  epsilonPx: 1,
} as const;

/**
 * Build the tuning for a fling launched at `barSpacing` px/bar. THE §13.13 FIX:
 * ε is divided by barSpacing so the stop threshold is one *pixel* of residual
 * travel rather than one bar — the reference left ε = 1 bar while dividing the
 * launch constants by barSpacing, so flings cut off early at large spacings.
 */
export function kineticTuningForBarSpacing(barSpacing: number): KineticTuning {
  return { damping: KINETIC.damping, epsilon: KINETIC.epsilonPx / barSpacing };
}

/**
 * Closed-form damped-glide animation (study 07 §4.11). `velocity` is in right-
 * offset units per ms (bars/ms) — already distance-weighted and clamped by the
 * host's velocity tracker. The decay curve and duration formula are bit-for-bit
 * the study-07 math; only the termination point uses the corrected ε (§13.13).
 *
 *   position(Δt) = p0 + v·(D^Δt − 1) / ln D
 *   duration     = ln( ε·(−ln D) / |v| ) / ln D
 *   finished(t)  = min(t − t0, duration) === duration   (i.e. t − t0 ≥ duration)
 */
export function createKineticAnimation(
  position: number,
  velocity: number,
  now: number,
  tuning: KineticTuning,
): HorzAnimation {
  const lnD = Math.log(tuning.damping);
  const speed = Math.abs(velocity);
  // total travel from launch = |v| / (−ln D); duration solves residual travel = ε.
  // When total travel < ε the arg to ln exceeds 1 → ln > 0 → duration < 0 (lnD<0)
  // → the animation is finished immediately (degenerate large-spacing case).
  const duration = speed > 0 ? Math.log((tuning.epsilon * -lnD) / speed) / lnD : 0;

  const positionAt = (t: number): number => {
    const dt = Math.min(Math.max(t - now, 0), Math.max(duration, 0));
    return position + (velocity * (Math.pow(tuning.damping, dt) - 1)) / lnD;
  };

  const finished = (t: number): boolean => {
    if (!(duration > 0)) return true; // never-launched / degenerate → finished
    return Math.min(t - now, duration) === duration;
  };

  return { finished, positionAt };
}

// ---------------------------------------------------------------------------
// HorzScaleCommand algebra + reducer (architecture §4.4).
// ---------------------------------------------------------------------------

export type HorzScaleCommand =
  | { kind: 'fitContent' }
  | { kind: 'applyRange'; range: LogicalRange }
  | { kind: 'setBarSpacing'; value: number }
  | { kind: 'setRightOffset'; value: number }
  | { kind: 'reset' }
  | { kind: 'animate'; animation: HorzAnimation }
  | { kind: 'stopAnimation' };

function withoutPendingAnimate(queue: readonly HorzScaleCommand[]): HorzScaleCommand[] {
  return queue.filter((c) => c.kind !== 'animate');
}

/**
 * Reduce a queued time-scale command stream (architecture §4.4 — the implicit
 * reference replace-vs-append rules made an explicit, tested law). Returns a NEW
 * array; never mutates `queue`. Laws:
 *   • fitContent / applyRange / reset REPLACE the whole queue (they imply both a
 *     spacing AND an offset change);
 *   • setBarSpacing / setRightOffset APPEND, after cancelling any pending animate;
 *   • animate REPLACES a pending animate (at most one may exist), else appends;
 *   • stopAnimation REMOVES a pending animate AND survives in the queue, so a
 *     later mask-merge also cancels the destination's in-flight animation.
 */
export function reduceHorzCommands(
  queue: readonly HorzScaleCommand[],
  next: HorzScaleCommand,
): readonly HorzScaleCommand[] {
  switch (next.kind) {
    case 'fitContent':
    case 'applyRange':
    case 'reset':
      return [next];
    case 'setBarSpacing':
    case 'setRightOffset':
    case 'animate':
    case 'stopAnimation':
      // All four cancel any pending animate, then append `next`. For animate this
      // is "replace the pending animate"; for stopAnimation the stop token then
      // survives in the queue (so a later mask-merge re-cancels at the destination).
      return [...withoutPendingAnimate(queue), next];
    default: {
      // Exhaustiveness guard — `next` is `never` here if the union is covered.
      const _exhaustive: never = next;
      return _exhaustive;
    }
  }
}

// ---------------------------------------------------------------------------
// Bar-spacing clamp (study 03 §4.5).
// ---------------------------------------------------------------------------

export interface BarSpacingClampParams {
  /** Scale width W, media px. */
  readonly width: number;
  /** options.minBarSpacing. */
  readonly minBarSpacing: number;
  /** options.maxBarSpacing — 0 means disabled (→ half the width). */
  readonly maxBarSpacing: number;
  /** N: number of data points (for the both-edges-fixed W/N rule). */
  readonly barCount: number;
  readonly fixLeftEdge?: boolean;
  readonly fixRightEdge?: boolean;
}

function maxSpacing(p: BarSpacingClampParams): number {
  return p.maxBarSpacing > 0 ? p.maxBarSpacing : p.width * MAX_SPACING_COEFF;
}

function minSpacing(p: BarSpacingClampParams): number {
  // both edges fixed and data present: cannot zoom out past "all data fills W".
  if (p.fixLeftEdge && p.fixRightEdge && p.barCount > 0) return p.width / p.barCount;
  return p.minBarSpacing;
}

/** Clamp S into [minSpacing(), maxSpacing()] (study 03 §4.5). */
export function clampBarSpacing(spacing: number, p: BarSpacingClampParams): number {
  return Math.min(Math.max(spacing, minSpacing(p)), maxSpacing(p));
}

// ---------------------------------------------------------------------------
// Right-offset clamp (study 03 §4.6).
// ---------------------------------------------------------------------------

export interface RightOffsetClampParams {
  /** Scale width W, media px. */
  readonly width: number;
  /** Bar spacing S, media px. */
  readonly barSpacing: number;
  /** First data index (0 in practice). */
  readonly firstIndex: number;
  /** Base index B — null when no series has data (skips the min bound). */
  readonly baseIndex: number | null;
  /** N: number of data points. */
  readonly barCount: number;
  readonly fixLeftEdge?: boolean;
  readonly fixRightEdge?: boolean;
}

/**
 * Clamp the right offset R into `[minR, maxR]` (study 03 §4.6):
 *   minR = firstIndex − B − 1 + (fixLeftEdge ? W/S : min(2,N))   (skipped if B null)
 *   maxR = fixRightEdge ? 0 : W/S − min(2,N)
 */
export function clampRightOffset(offset: number, p: RightOffsetClampParams): number {
  const barsPerScreen = p.width / p.barSpacing;
  const minVisible = Math.min(MIN_VISIBLE_BARS, p.barCount);
  const maxR = p.fixRightEdge ? 0 : barsPerScreen - minVisible;

  let r = Math.min(offset, maxR);
  if (p.baseIndex !== null) {
    const leftTerm = p.fixLeftEdge ? barsPerScreen : minVisible;
    const minR = p.firstIndex - p.baseIndex - 1 + leftTerm;
    r = Math.max(r, minR);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Right-offset compensation — three-flag follow/stay rule (study 01 §4.4).
// ---------------------------------------------------------------------------

export interface CompensationInput {
  /** Current right offset (bars). */
  readonly rightOffset: number;
  /** Base index before the data update. */
  readonly oldBaseIndex: number;
  /** Base index after the update — null when no series has data. */
  readonly newBaseIndex: number | null;
  /** Whether the OLD base index is inside the current strict visible range. */
  readonly lastBarVisible: boolean;
  /** Whether index-0's key got older (history prepended). */
  readonly leftShifted: boolean;
  /** Whether this update only filled an existing whitespace slot (no new points). */
  readonly replacedWhitespace: boolean;
  readonly shiftVisibleRangeOnNewBar: boolean;
  readonly allowShiftVisibleRangeOnWhitespaceReplacement: boolean;
}

/**
 * The new-bar follow/stay decision (study 01 §4.4). Returns the (possibly
 * compensated) right offset. Because R is right-anchored, doing nothing shifts
 * the view to follow the newest bar; compensation subtracts the appended-bar
 * count so the viewport stays glued to the same bars.
 *
 *   addedToRight = (newBase != null AND newBase > oldBase) AND not leftShifted
 *   wantShift    = lastBarVisible
 *                  AND (not replacedWhitespace OR allowShiftOnWhitespaceReplacement)
 *                  AND shiftVisibleRangeOnNewBar
 *   if addedToRight and not wantShift: R −= (newBase − oldBase)
 */
export function compensateRightOffset(i: CompensationInput): number {
  // Explicit null guard: never evaluate `null > n` (study 01 §4.4).
  const pointsAdded = i.newBaseIndex !== null && i.newBaseIndex > i.oldBaseIndex;
  const addedToRight = pointsAdded && !i.leftShifted;
  const wantShift =
    i.lastBarVisible &&
    (!i.replacedWhitespace || i.allowShiftVisibleRangeOnWhitespaceReplacement) &&
    i.shiftVisibleRangeOnNewBar;

  if (addedToRight && !wantShift) {
    // newBaseIndex is non-null here (pointsAdded was true).
    return i.rightOffset - ((i.newBaseIndex as number) - i.oldBaseIndex);
  }
  return i.rightOffset;
}

// ---------------------------------------------------------------------------
// rightOffsetPixels px↔bars normalization (design 02 §5.3.4).
// ---------------------------------------------------------------------------

/** set / option-apply / reset: offset(bars) = px / S. A configured px of 0
 *  yields 0 bars (indistinguishable from rightOffset:0; design 02 §5.3.4). */
export function rightOffsetFromPixels(px: number, barSpacing: number): number {
  return px / barSpacing;
}

/** zoom (S → S′): re-derive offset ← offset · S / S′ to keep the pixel gap
 *  constant. The guard is on the OLD-spacing numerator factor (`oldS`), not the
 *  divisor — the new spacing is already clamped ≥ minBarSpacing (design 02 §5.3.4
 *  / study 03 §4.8). */
export function rightOffsetForPixels(offset: number, oldSpacing: number, newSpacing: number): number {
  if (!(oldSpacing > 0)) return offset;
  return (offset * oldSpacing) / newSpacing;
}

/** fitContent with a pixel reservation: S = (W − px) / N, then offset = px / S
 *  (design 02 §5.3.4). N is the fitted bar count. */
export function fitContentWithPixels(
  width: number,
  px: number,
  barCount: number,
): { barSpacing: number; rightOffset: number } {
  const barSpacing = (width - px) / barCount;
  return { barSpacing, rightOffset: px / barSpacing };
}
