// Model-owned animation values for the time scale and the last-price pulse
// (architecture §4.4 + §4.4.8; design 02 §9; study 03 §4.8; study 06 §4.15).
// Pure math — no model reference, no scheduler, no DOM. Each animation is a
// `function(now) -> value` plus a `finished(now)`/`done(now)` predicate; the
// scheduler RE-ARM wiring (host/frame-scheduler) samples these until done and
// is the INTEGRATE phase's job, not this file's.
//
// Two distinct shapes live here:
//   • the animated SCROLL — a 350 ms ease-out-cubic `HorzAnimation` for
//     `scrollToPosition(.., true)` / `scrollToRealTime()` (design 02 §9 /
//     deviation 10: ONE 350 ms eased constant replacing the reference's
//     1000 ms-public / 400 ms-internal MECHANICAL LINEAR lerp, study 03
//     IMPROVE). It re-arms at Render — it moves geometry (architecture §4.4).
//   • the last-price PULSE — a bounded 2600 ms three-stage keyframe table
//     (study 06 §4.15) exposed as an OVERLAY-level animation ticket that
//     NEVER promotes to a Render frame (architecture §4.4.8: promoting it
//     would re-run autoscale ~60×/s while the pulse decays).
//
// The KINETIC fling lives next door in `time-scale/navigator.ts`
// (`createKineticAnimation`, study 07 §4.11 + the §13.13 ε/barSpacing FIX) —
// it shares the `HorzAnimation` shape, re-exported here for one import site.
import type { HorzAnimation } from './time-scale/navigator';

// ---------------------------------------------------------------------------
// Animated scroll — 350 ms ease-out cubic (design 02 §9 / deviation 10).
// ---------------------------------------------------------------------------

/** The single scroll-animation duration constant (design 02 §9 / deviation 10).
 *  Replaces the reference's two arbitrary constants (1000 ms public scroll-to-
 *  position, 400 ms internal scroll-to-real-time). */
export const SCROLL_ANIMATION_DURATION_MS = 350;

/**
 * Ease-out cubic on a normalized progress `p ∈ [0, 1]`: `1 − (1 − p)³`.
 * The eased replacement for the reference's mechanical linear lerp (study 03
 * IMPROVE / design 02 deviation 10). f(0)=0, f(1)=1, monotone, with a zero
 * terminal slope (the motion decelerates into the target). Inputs outside
 * [0,1] are clamped so a stale/late `now` can never overshoot or rewind.
 */
export function easeOutCubic(progress: number): number {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const inv = 1 - p;
  return 1 - inv * inv * inv;
}

/**
 * Build a `HorzAnimation` that eases the right offset from `from` to `to` over
 * `duration` ms (default the single 350 ms constant), starting at `now`
 * (design 02 §9). Same `HorzAnimation` contract as the kinetic fling, so it
 * flows through the identical `{ kind: 'animate' }` command and the Render-
 * level scheduler re-arm (architecture §4.4): it moves geometry.
 *
 *   position(t) = from + (to − from) · easeOutCubic((t − t0) / duration)
 *   finished(t) = (t − t0) ≥ duration   (and immediately when duration ≤ 0)
 *
 * Progress is clamped into [0,1] inside `easeOutCubic`, so `positionAt(t0)`
 * is exactly `from` and `positionAt(t ≥ t0+duration)` is exactly `to`
 * (the eased curve hits its endpoints by construction).
 */
export function createScrollAnimation(
  from: number,
  to: number,
  now: number,
  duration: number = SCROLL_ANIMATION_DURATION_MS,
): HorzAnimation {
  const span = to - from;

  const positionAt = (t: number): number => {
    if (!(duration > 0)) return to; // degenerate: jump to target
    return from + span * easeOutCubic((t - now) / duration);
  };

  const finished = (t: number): boolean => {
    if (!(duration > 0)) return true;
    return t - now >= duration;
  };

  return { finished, positionAt };
}

// ---------------------------------------------------------------------------
// Last-price PULSE — bounded keyframe table (study 06 §4.15, architecture §4.4.8).
// ---------------------------------------------------------------------------

/** Pulse period, ms (study 06 §4.15). One full radius-grow / fade / rest cycle. */
export const PULSE_PERIOD_MS = 2600;

/** A sampled pulse frame: the three interpolated geometry/alpha values the
 *  renderer needs (study 06 §4.15). The series color + the solid center-dot
 *  radius are applied renderer-side (`views`); this is the pure keyframe value
 *  so the model never names a gfx/color type (architecture §3.1 wall). */
export interface PulseFrame {
  /** Outer circle radius, in media px (4 → 14 across the cycle). */
  readonly radius: number;
  /** Translucent fill-circle alpha (0.25 → 0, then 0). */
  readonly fillAlpha: number;
  /** Stroke-ring alpha (0.4 → 0.8 → 0). */
  readonly strokeAlpha: number;
}

/**
 * The §4.15 keyframe table — three stages keyed by normalized phase
 * `t = (elapsed mod 2600) / 2600`, values LINEARLY interpolated within a
 * stage (study 06 §4.15, "keep the exact constants"):
 *   Stage 1, t∈[0, 0.25]   : radius 4→10,  fill 0.25→0,  stroke 0.4→0.8
 *   Stage 2, t∈[0.25, 0.525]: radius 10→14, fill 0→0,    stroke 0.8→0
 *   Stage 3, t∈[0.525, 1.0] : radius 14,    fill 0,       stroke 0  (rest)
 * Each row is the keyframe at the START of its phase; the value at a phase is
 * the lerp between the bracketing rows. The closing sentinel at t=1 equals the
 * stage-3 rest values so the table is total over [0,1].
 */
export const PULSE_KEYFRAMES: readonly (PulseFrame & { readonly t: number })[] = [
  { t: 0, radius: 4, fillAlpha: 0.25, strokeAlpha: 0.4 },
  { t: 0.25, radius: 10, fillAlpha: 0, strokeAlpha: 0.8 },
  { t: 0.525, radius: 14, fillAlpha: 0, strokeAlpha: 0 },
  { t: 1, radius: 14, fillAlpha: 0, strokeAlpha: 0 },
];

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/**
 * Sample the §4.15 keyframe table at a normalized phase `t ∈ [0, 1]`. Finds
 * the bracketing keyframes and linearly interpolates each channel. `t` is
 * clamped so an out-of-range phase saturates at an endpoint rather than NaN.
 */
export function pulseFrameAtPhase(t: number): PulseFrame {
  const phase = t < 0 ? 0 : t > 1 ? 1 : t;
  // Walk to the first keyframe whose t is ≥ phase: [prev, k] bracket it.
  for (let i = 1; i < PULSE_KEYFRAMES.length; i++) {
    const k = PULSE_KEYFRAMES[i] as PulseFrame & { t: number };
    if (phase <= k.t) {
      const prev = PULSE_KEYFRAMES[i - 1] as PulseFrame & { t: number };
      const denom = k.t - prev.t;
      const u = denom > 0 ? (phase - prev.t) / denom : 0;
      return {
        radius: lerp(prev.radius, k.radius, u),
        fillAlpha: lerp(prev.fillAlpha, k.fillAlpha, u),
        strokeAlpha: lerp(prev.strokeAlpha, k.strokeAlpha, u),
      };
    }
  }
  // phase === 1 falls here (the final sentinel); return the rest frame.
  const last = PULSE_KEYFRAMES[PULSE_KEYFRAMES.length - 1] as PulseFrame;
  return { radius: last.radius, fillAlpha: last.fillAlpha, strokeAlpha: last.strokeAlpha };
}

/**
 * The model-owned last-price PULSE animation (study 06 §4.15, architecture
 * §4.4.8). A bounded, periodic keyframe sampler:
 *   • `frameAt(now)` returns the interpolated `PulseFrame` at the phase
 *     `((now − startTime) mod 2600) / 2600`;
 *   • `endTime` bounds the run — the animation `done(now)` once `now ≥ endTime`.
 *
 * THE §4.4.8 INVARIANT (encoded as the `overlay` tag, not just prose): this is
 * an OVERLAY-level ticket. The scheduler must re-arm it through the Overlay
 * branch and MUST NOT promote it to a Render frame (that would re-run autoscale
 * ~60×/s while the pulse decays). The model carries no DOM and no scheduler —
 * `done`/`frameAt` are pure functions of `now`.
 */
export interface PulseAnimation {
  /** Architecture §4.4.8: re-arm at Overlay ONLY — never promotes to Render. */
  readonly level: 'overlay';
  /** True once `now` reaches the bounded end time (the animation may stop). */
  done(now: number): boolean;
  /** The interpolated keyframe at `now` (phase wraps every 2600 ms). */
  frameAt(now: number): PulseFrame;
}

/**
 * The mode union (design 02 — `LastPriceAnimationMode`, a string union not an
 * enum). `'continuous'` runs unbounded; `'on-data-update'` runs one bounded
 * burst per realtime bar; `'disabled'` produces no animation at the call site.
 */
export type LastPriceAnimationMode = 'disabled' | 'continuous' | 'on-data-update';

/**
 * Build a last-price pulse (study 06 §4.15). `startTime` anchors phase 0;
 * `endTime` bounds the run (Infinity for `'continuous'`, which never `done`s).
 * The §4.15 anti-stutter rule for `'on-data-update'` (a fresh tick with < one
 * quarter-period remaining EXTENDS the end by one period rather than restarting
 * the phase) is applied by the caller via `extendPulseEnd` so the phase stays
 * continuous across the extension — the keyframe sampler is purely `startTime`-
 * relative and must not jump.
 */
export function createPulseAnimation(startTime: number, endTime: number): PulseAnimation {
  const frameAt = (now: number): PulseFrame => {
    const elapsed = now - startTime;
    // Modulo that is correct for any non-negative elapsed; a `now` before the
    // start (shouldn't happen) clamps to phase 0.
    const e = elapsed > 0 ? elapsed % PULSE_PERIOD_MS : 0;
    return pulseFrameAtPhase(e / PULSE_PERIOD_MS);
  };

  const done = (now: number): boolean => now >= endTime;

  return { level: 'overlay', done, frameAt };
}

/**
 * The §4.15 'on-data-update' anti-stutter end-time rule, as pure math (study 06
 * §4.15): on a new realtime bar at `now`, restart unless the running animation
 * has LESS THAN one quarter-period (2600/4 = 650 ms) remaining — in which case
 * EXTEND the existing end by one full period to avoid a visible stutter. Returns
 * the new `{ startTime, endTime }`:
 *   • not running (now ≥ currentEnd): fresh burst, end = now + period;
 *   • running with ≥ period/4 left: restart phase, end = now + period;
 *   • running with < period/4 left: keep the phase (startTime unchanged),
 *     end = currentEnd + period.
 */
export function extendPulseEnd(
  currentStart: number,
  currentEnd: number,
  now: number,
): { startTime: number; endTime: number } {
  const remaining = currentEnd - now;
  if (remaining > 0 && remaining < PULSE_PERIOD_MS / 4) {
    // Less than a quarter-period left → extend, preserving phase continuity.
    return { startTime: currentStart, endTime: currentEnd + PULSE_PERIOD_MS };
  }
  // Not running, or comfortably running → (re)start a fresh burst from `now`.
  return { startTime: now, endTime: now + PULSE_PERIOD_MS };
}
