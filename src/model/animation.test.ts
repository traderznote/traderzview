import { describe, expect, test } from 'vitest';
import {
  PULSE_KEYFRAMES,
  PULSE_PERIOD_MS,
  SCROLL_ANIMATION_DURATION_MS,
  createPulseAnimation,
  createScrollAnimation,
  easeOutCubic,
  extendPulseEnd,
  pulseFrameAtPhase,
} from './animation';
import {
  createKineticAnimation,
  kineticTuningForBarSpacing,
  type HorzAnimation,
} from './time-scale/navigator';

// ===========================================================================
// Animated SCROLL — 350 ms ease-out cubic (design 02 §9 / deviation 10).
// ===========================================================================
describe('createScrollAnimation — 350 ms ease-out cubic (design 02 §9)', () => {
  test('THE single duration constant is 350 ms (not 1000 / 400)', () => {
    expect(SCROLL_ANIMATION_DURATION_MS).toBe(350);
  });

  test('easeOutCubic is 1 − (1−p)³: hits both endpoints, monotone, eased', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    // hand-derived: p=0.5 → 1 − 0.5³ = 1 − 0.125 = 0.875
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875, 12);
    // p=0.25 → 1 − 0.75³ = 1 − 0.421875 = 0.578125
    expect(easeOutCubic(0.25)).toBeCloseTo(0.578125, 12);
    // strictly eased (ahead of the linear lerp it replaces) in the interior
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5);
    // monotone non-decreasing across the unit interval
    let prev = -1;
    for (let i = 0; i <= 10; i++) {
      const v = easeOutCubic(i / 10);
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test('easeOutCubic clamps out-of-range progress (no overshoot / rewind)', () => {
    expect(easeOutCubic(-0.5)).toBe(0);
    expect(easeOutCubic(1.5)).toBe(1);
  });

  test('positionAt(t0) is exactly `from`; positionAt(t0+350) is exactly `to`', () => {
    const a = createScrollAnimation(20, 80, 1000);
    expect(a.positionAt(1000)).toBe(20);
    expect(a.positionAt(1000 + 350)).toBe(80);
    expect(a.positionAt(1000 + 1000)).toBe(80); // clamped past the end
  });

  test('GOLDEN eased position samples (from=0, to=100, t0=0, dur=350)', () => {
    const a = createScrollAnimation(0, 100, 0);
    // p = t/350; position = 100 · (1 − (1−p)³)
    const at = (t: number): number => 100 * easeOutCubic(t / 350);
    expect(a.positionAt(175)).toBeCloseTo(at(175), 12); // mid: p=0.5 → 87.5
    expect(a.positionAt(175)).toBeCloseTo(87.5, 12);
    expect(a.positionAt(87.5)).toBeCloseTo(at(87.5), 12); // quarter: p=0.25 → 57.8125
    expect(a.positionAt(87.5)).toBeCloseTo(57.8125, 12);
  });

  test('eased curve LEADS the mechanical linear lerp at the same progress (study 03 IMPROVE)', () => {
    const a = createScrollAnimation(0, 100, 0);
    const linearAtMid = 0 + (100 - 0) * (175 / 350); // = 50
    expect(a.positionAt(175)).toBeGreaterThan(linearAtMid);
  });

  test('finished only at/after t0 + duration', () => {
    const a = createScrollAnimation(20, 80, 1000);
    expect(a.finished(1000)).toBe(false);
    expect(a.finished(1000 + 349)).toBe(false);
    expect(a.finished(1000 + 350)).toBe(true);
    expect(a.finished(1000 + 500)).toBe(true);
  });

  test('a negative span (scroll left) eases symmetrically', () => {
    const a = createScrollAnimation(100, 40, 0);
    expect(a.positionAt(0)).toBe(100);
    expect(a.positionAt(175)).toBeCloseTo(100 + (40 - 100) * 0.875, 12); // 100 − 52.5 = 47.5
    expect(a.positionAt(350)).toBe(40);
  });

  test('degenerate duration ≤ 0 → finished immediately, positionAt is the target', () => {
    const a = createScrollAnimation(10, 90, 0, 0);
    expect(a.finished(0)).toBe(true);
    expect(a.positionAt(0)).toBe(90);
    const neg = createScrollAnimation(10, 90, 0, -5);
    expect(neg.finished(0)).toBe(true);
    expect(neg.positionAt(123)).toBe(90);
  });

  test('an explicit duration override is honored (the constant is only the default)', () => {
    const a = createScrollAnimation(0, 100, 0, 700);
    expect(a.finished(350)).toBe(false); // would be finished at the default 350
    expect(a.finished(700)).toBe(true);
    expect(a.positionAt(350)).toBeCloseTo(100 * easeOutCubic(0.5), 12);
  });

  test('satisfies the shared HorzAnimation contract', () => {
    const a: HorzAnimation = createScrollAnimation(0, 1, 0);
    expect(typeof a.finished).toBe('function');
    expect(typeof a.positionAt).toBe('function');
  });
});

// ===========================================================================
// Last-price PULSE — bounded keyframe table (study 06 §4.15, architecture §4.4.8).
// ===========================================================================
describe('last-price pulse keyframes (study 06 §4.15)', () => {
  test('period is 2600 ms', () => {
    expect(PULSE_PERIOD_MS).toBe(2600);
  });

  test('keyframe table holds the EXACT §4.15 constants at the stage boundaries', () => {
    expect(PULSE_KEYFRAMES).toEqual([
      { t: 0, radius: 4, fillAlpha: 0.25, strokeAlpha: 0.4 },
      { t: 0.25, radius: 10, fillAlpha: 0, strokeAlpha: 0.8 },
      { t: 0.525, radius: 14, fillAlpha: 0, strokeAlpha: 0 },
      { t: 1, radius: 14, fillAlpha: 0, strokeAlpha: 0 },
    ]);
  });

  test('stage boundaries sample to the keyframe values exactly', () => {
    // Stage 1 start
    expect(pulseFrameAtPhase(0)).toEqual({ radius: 4, fillAlpha: 0.25, strokeAlpha: 0.4 });
    // Stage 1→2 boundary (t=0.25): radius 10, fill 0, stroke 0.8
    expect(pulseFrameAtPhase(0.25)).toEqual({ radius: 10, fillAlpha: 0, strokeAlpha: 0.8 });
    // Stage 2→3 boundary (t=0.525): radius 14, fill 0, stroke 0
    expect(pulseFrameAtPhase(0.525)).toEqual({ radius: 14, fillAlpha: 0, strokeAlpha: 0 });
    // Rest phase end (t=1)
    expect(pulseFrameAtPhase(1)).toEqual({ radius: 14, fillAlpha: 0, strokeAlpha: 0 });
  });

  test('stage 1 interpolates linearly (radius 4→10, fill 0.25→0, stroke 0.4→0.8)', () => {
    // midway through stage 1: phase 0.125 → u = 0.5
    const f = pulseFrameAtPhase(0.125);
    expect(f.radius).toBeCloseTo(7, 12); // (4+10)/2
    expect(f.fillAlpha).toBeCloseTo(0.125, 12); // (0.25+0)/2
    expect(f.strokeAlpha).toBeCloseTo(0.6, 12); // (0.4+0.8)/2
  });

  test('stage 2 interpolates (radius 10→14, fill stays 0, stroke 0.8→0)', () => {
    // midway through stage 2: phase = 0.25 + (0.525−0.25)/2 = 0.3875 → u = 0.5
    const f = pulseFrameAtPhase(0.3875);
    expect(f.radius).toBeCloseTo(12, 12); // (10+14)/2
    expect(f.fillAlpha).toBeCloseTo(0, 12);
    expect(f.strokeAlpha).toBeCloseTo(0.4, 12); // (0.8+0)/2
  });

  test('stage 3 is the rest phase: radius 14, all alphas 0 throughout', () => {
    for (const phase of [0.525, 0.6, 0.75, 0.9, 1]) {
      const f = pulseFrameAtPhase(phase);
      expect(f.radius).toBeCloseTo(14, 12);
      expect(f.fillAlpha).toBe(0);
      expect(f.strokeAlpha).toBe(0);
    }
  });

  test('keyframe values stay within their declared bounds across the whole cycle', () => {
    for (let i = 0; i <= 100; i++) {
      const f = pulseFrameAtPhase(i / 100);
      expect(f.radius).toBeGreaterThanOrEqual(4);
      expect(f.radius).toBeLessThanOrEqual(14);
      expect(f.fillAlpha).toBeGreaterThanOrEqual(0);
      expect(f.fillAlpha).toBeLessThanOrEqual(0.25);
      expect(f.strokeAlpha).toBeGreaterThanOrEqual(0);
      expect(f.strokeAlpha).toBeLessThanOrEqual(0.8);
    }
  });

  test('out-of-range phase clamps (no NaN)', () => {
    expect(pulseFrameAtPhase(-1)).toEqual({ radius: 4, fillAlpha: 0.25, strokeAlpha: 0.4 });
    expect(pulseFrameAtPhase(2)).toEqual({ radius: 14, fillAlpha: 0, strokeAlpha: 0 });
  });
});

describe('createPulseAnimation — Overlay ticket (architecture §4.4.8)', () => {
  test('tagged level "overlay" so it can NEVER promote to a Render frame (§4.4.8)', () => {
    const a = createPulseAnimation(0, 2600);
    expect(a.level).toBe('overlay');
  });

  test('frameAt(startTime) is phase 0 (the first keyframe)', () => {
    const a = createPulseAnimation(1000, 1000 + PULSE_PERIOD_MS);
    expect(a.frameAt(1000)).toEqual({ radius: 4, fillAlpha: 0.25, strokeAlpha: 0.4 });
  });

  test('phase wraps every 2600 ms (a periodic keyframe sequence)', () => {
    const a = createPulseAnimation(0, Number.POSITIVE_INFINITY);
    // elapsed 650 ms → phase 0.25 (the stage 1→2 boundary)
    const atQuarter = a.frameAt(650);
    expect(atQuarter.radius).toBeCloseTo(10, 12);
    // one full period later samples the same phase
    expect(a.frameAt(650 + PULSE_PERIOD_MS)).toEqual(atQuarter);
    // mid-cycle equals the equivalent phase a cycle later
    expect(a.frameAt(1300)).toEqual(a.frameAt(1300 + 2 * PULSE_PERIOD_MS));
  });

  test('bounded run: done(now) once now reaches the end time', () => {
    const a = createPulseAnimation(0, 2600);
    expect(a.done(0)).toBe(false);
    expect(a.done(2599)).toBe(false);
    expect(a.done(2600)).toBe(true);
    expect(a.done(9999)).toBe(true);
  });

  test('continuous mode (endTime = Infinity) never reports done', () => {
    const a = createPulseAnimation(0, Number.POSITIVE_INFINITY);
    expect(a.done(0)).toBe(false);
    expect(a.done(1e9)).toBe(false);
  });
});

describe('extendPulseEnd — §4.15 on-data-update anti-stutter rule', () => {
  test('not running (now ≥ currentEnd) → fresh burst from now', () => {
    // currentEnd 1000, a tick at 1500 (past the end) → restart at 1500
    expect(extendPulseEnd(0, 1000, 1500)).toEqual({ startTime: 1500, endTime: 1500 + PULSE_PERIOD_MS });
  });

  test('running with ≥ a quarter-period left → restart phase from now', () => {
    // currentEnd 3000, tick at 1000 → remaining 2000 ≥ 650 → restart
    expect(extendPulseEnd(400, 3000, 1000)).toEqual({ startTime: 1000, endTime: 1000 + PULSE_PERIOD_MS });
  });

  test('running with < a quarter-period left → EXTEND by one period, keep phase', () => {
    // currentEnd 1000, tick at 600 → remaining 400 < 650 → extend; startTime unchanged
    expect(extendPulseEnd(0, 1000, 600)).toEqual({ startTime: 0, endTime: 1000 + PULSE_PERIOD_MS });
  });

  test('exactly a quarter-period left is NOT < period/4 → restart (boundary)', () => {
    // remaining exactly 650 → not strictly less → restart
    expect(extendPulseEnd(0, 1650, 1000)).toEqual({ startTime: 1000, endTime: 1000 + PULSE_PERIOD_MS });
  });

  test('extension preserves phase continuity across the seam', () => {
    // run started at 0, end 1000; a tick at 600 (remaining 400 < 650) extends.
    const { startTime, endTime } = extendPulseEnd(0, 1000, 600);
    const a = createPulseAnimation(startTime, endTime);
    // the phase at the extension instant is unchanged (start unchanged) — no jump
    expect(a.frameAt(600)).toEqual(pulseFrameAtPhase(600 / PULSE_PERIOD_MS));
    expect(a.done(600)).toBe(false); // end pushed out to 3600
    expect(endTime).toBe(3600);
  });
});

// ===========================================================================
// KINETIC fling — re-verify against the M5 GOLDEN (study 07 §4.11 + §13.13 ε FIX).
// (createKineticAnimation lives in time-scale/navigator.ts; this re-asserts the
//  golden so the animations stream owns a regression net for the kinetic math.)
// ===========================================================================
describe('createKineticAnimation re-verified vs the M5 golden (study 07 §4.11)', () => {
  test('GOLDEN duration & position for v0=0.5 bars/ms at barSpacing 6', () => {
    const tuning = kineticTuningForBarSpacing(6);
    expect(tuning.damping).toBe(0.997);
    expect(tuning.epsilon).toBeCloseTo(1 / 6, 12);

    const v0 = 3 / 6; // 3 px/ms at S=6 → 0.5 bars/ms
    const a = createKineticAnimation(100, v0, 0, tuning);
    const lnD = Math.log(0.997);
    const expectedDuration = Math.log((tuning.epsilon * -lnD) / Math.abs(v0)) / lnD;
    const totalTravel = Math.abs(v0) / -lnD;

    expect(a.finished(0)).toBe(false);
    expect(a.finished(expectedDuration)).toBe(true);
    // at the duration the residual travel is exactly ε (the §13.13 stop point)
    expect(a.positionAt(expectedDuration)).toBeCloseTo(100 + totalTravel - tuning.epsilon, 6);
    // a known mid sample at Δt=200 ms
    const pMid = 100 + (v0 * (Math.pow(0.997, 200) - 1)) / lnD;
    expect(a.positionAt(200)).toBeCloseTo(pMid, 9);
  });

  test('§13.13 ε FIX: per-pixel ε makes the fling duration INVARIANT to barSpacing', () => {
    const lnD = Math.log(0.997);
    const durAt = (S: number): number => {
      const t = kineticTuningForBarSpacing(S);
      const v = 3 / S; // a 3 px/ms physical fling at spacing S
      return Math.log((t.epsilon * -lnD) / Math.abs(v)) / lnD;
    };
    expect(durAt(60)).toBeCloseTo(durAt(6), 9); // FIXED: equal at any zoom
  });

  test('positionAt(t0) is the launch position', () => {
    const a = createKineticAnimation(42, 0.3, 1000, kineticTuningForBarSpacing(6));
    expect(a.positionAt(1000)).toBeCloseTo(42, 9);
  });
});
