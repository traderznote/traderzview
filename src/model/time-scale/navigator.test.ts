import { describe, expect, test } from 'vitest';
import type { LogicalRange } from './geometry';
import {
  KINETIC,
  type HorzAnimation,
  type HorzScaleCommand,
  clampBarSpacing,
  clampRightOffset,
  compensateRightOffset,
  createKineticAnimation,
  kineticTuningForBarSpacing,
  reduceHorzCommands,
  rightOffsetForPixels,
  rightOffsetFromPixels,
} from './navigator';

const range = (from: number, to: number): LogicalRange => ({ from: from as never, to: to as never });

// ---------------------------------------------------------------------------
// reduceHorzCommands — the closed command algebra (architecture §4.4 laws).
// ---------------------------------------------------------------------------
describe('reduceHorzCommands laws (architecture §4.4)', () => {
  const fit: HorzScaleCommand = { kind: 'fitContent' };
  const reset: HorzScaleCommand = { kind: 'reset' };
  const applyRange: HorzScaleCommand = { kind: 'applyRange', range: range(1, 10) };
  const bar = (v: number): HorzScaleCommand => ({ kind: 'setBarSpacing', value: v });
  const off = (v: number): HorzScaleCommand => ({ kind: 'setRightOffset', value: v });
  const anim = (): HorzScaleCommand => ({
    kind: 'animate',
    animation: { finished: () => true, positionAt: () => 0 },
  });
  const stop: HorzScaleCommand = { kind: 'stopAnimation' };

  test('fitContent REPLACES the whole queue', () => {
    const q: HorzScaleCommand[] = [bar(6), off(2), anim()];
    expect(reduceHorzCommands(q, fit)).toEqual([fit]);
  });

  test('applyRange REPLACES the whole queue', () => {
    const q: HorzScaleCommand[] = [bar(6), off(2)];
    expect(reduceHorzCommands(q, applyRange)).toEqual([applyRange]);
  });

  test('reset REPLACES the whole queue', () => {
    const q: HorzScaleCommand[] = [bar(6), off(2), anim()];
    expect(reduceHorzCommands(q, reset)).toEqual([reset]);
  });

  test('setBarSpacing APPENDS', () => {
    expect(reduceHorzCommands([off(2)], bar(8))).toEqual([off(2), bar(8)]);
  });

  test('setRightOffset APPENDS', () => {
    expect(reduceHorzCommands([bar(8)], off(3))).toEqual([bar(8), off(3)]);
  });

  test('setBarSpacing / setRightOffset CANCEL a pending animation before appending', () => {
    const a = anim();
    expect(reduceHorzCommands([off(1), a], bar(8))).toEqual([off(1), bar(8)]);
    expect(reduceHorzCommands([bar(8), a], off(3))).toEqual([bar(8), off(3)]);
  });

  test('animate REPLACES a pending animate (only one may exist)', () => {
    const a1 = anim();
    const a2 = anim();
    const out = reduceHorzCommands([off(1), a1], a2);
    expect(out).toEqual([off(1), a2]);
    expect(out[out.length - 1]).toBe(a2);
  });

  test('animate appends when none is pending', () => {
    const a = anim();
    expect(reduceHorzCommands([bar(6)], a)).toEqual([bar(6), a]);
  });

  test('stopAnimation REMOVES a pending animate AND survives in the queue', () => {
    const a = anim();
    const out = reduceHorzCommands([off(1), a], stop);
    // the animate is gone; the stopAnimation token remains so a later mask-merge
    // also cancels the destination's in-flight animation (architecture §4.4).
    expect(out).toEqual([off(1), stop]);
  });

  test('stopAnimation with no pending animate still survives', () => {
    expect(reduceHorzCommands([bar(6)], stop)).toEqual([bar(6), stop]);
  });

  test('reducer never mutates the input queue', () => {
    const q: HorzScaleCommand[] = [bar(6), off(2)];
    const snapshot = [...q];
    reduceHorzCommands(q, fit);
    expect(q).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// Bar-spacing clamps (study 03 §4.5).
// ---------------------------------------------------------------------------
describe('clampBarSpacing (study 03 §4.5)', () => {
  test('clamps below to minBarSpacing', () => {
    expect(clampBarSpacing(0.1, { width: 800, minBarSpacing: 0.5, maxBarSpacing: 0, barCount: 100 })).toBe(0.5);
  });

  test('maxBarSpacing 0 (disabled) → max is half the width', () => {
    expect(clampBarSpacing(9999, { width: 800, minBarSpacing: 0.5, maxBarSpacing: 0, barCount: 100 })).toBe(400);
  });

  test('explicit maxBarSpacing caps', () => {
    expect(clampBarSpacing(100, { width: 800, minBarSpacing: 0.5, maxBarSpacing: 50, barCount: 100 })).toBe(50);
  });

  test('both edges fixed raises min spacing to W/N', () => {
    // fixLeftEdge && fixRightEdge && N>0 → minSpacing = W / N = 800/100 = 8
    expect(
      clampBarSpacing(2, { width: 800, minBarSpacing: 0.5, maxBarSpacing: 0, barCount: 100, fixLeftEdge: true, fixRightEdge: true }),
    ).toBe(8);
  });

  test('value within range is unchanged', () => {
    expect(clampBarSpacing(6, { width: 800, minBarSpacing: 0.5, maxBarSpacing: 0, barCount: 100 })).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Right-offset clamps (study 03 §4.6).
// ---------------------------------------------------------------------------
describe('clampRightOffset (study 03 §4.6)', () => {
  const base = { width: 600, barSpacing: 6, firstIndex: 0, baseIndex: 99, barCount: 100 };
  test('maxR without fixRightEdge = W/S − min(2,N)', () => {
    // W/S = 100; min(2,100)=2; maxR = 98
    expect(clampRightOffset(1000, base)).toBe(98);
  });

  test('fixRightEdge forbids any margin: maxR = 0', () => {
    expect(clampRightOffset(50, { ...base, fixRightEdge: true })).toBe(0);
  });

  test('minR without fixLeftEdge = firstIndex − B − 1 + min(2,N)', () => {
    // 0 − 99 − 1 + 2 = −98
    expect(clampRightOffset(-1000, base)).toBe(-98);
  });

  test('null base index skips the min bound (no data)', () => {
    // only the max bound applies; a large value still clamps to maxR
    expect(clampRightOffset(1000, { ...base, baseIndex: null })).toBe(98);
    // a very negative value is left alone (no min bound)
    expect(clampRightOffset(-1000, { ...base, baseIndex: null })).toBe(-1000);
  });

  test('single data point requires only 1 bar visible (min(2,N) with N=1)', () => {
    const one = { width: 600, barSpacing: 6, firstIndex: 0, baseIndex: 0, barCount: 1 };
    // maxR = 100 − 1 = 99 ; minR = 0 − 0 − 1 + 1 = 0
    expect(clampRightOffset(1000, one)).toBe(99);
    expect(clampRightOffset(-1000, one)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Offset compensation — three-flag follow/stay rule (study 01 §4.4).
// ---------------------------------------------------------------------------
describe('compensateRightOffset (study 01 §4.4 three-flag truth table)', () => {
  const baseInput = {
    rightOffset: 0,
    oldBaseIndex: 99,
    newBaseIndex: 102, // 3 points appended on the right
    lastBarVisible: true,
    leftShifted: false,
    replacedWhitespace: false,
    shiftVisibleRangeOnNewBar: true,
    allowShiftVisibleRangeOnWhitespaceReplacement: false,
  };

  test('default streaming: last bar visible + shift wanted → DO NOT compensate (view follows)', () => {
    expect(compensateRightOffset(baseInput)).toBe(0);
  });

  test('shift disabled while last bar visible → compensate so the view stays still', () => {
    // R −= (newBase − oldBase) = 0 − 3 = −3
    expect(compensateRightOffset({ ...baseInput, shiftVisibleRangeOnNewBar: false })).toBe(-3);
  });

  test('last bar NOT visible → wantShift is false, so appended points are compensated (history view stays still)', () => {
    // lastBarVisible is a conjunct of wantShift; false ⇒ wantShift false ⇒ since
    // points were added to the right, compensate so the user inspecting history
    // does not have the chart run away (study 03 §3.3/§5).
    expect(compensateRightOffset({ ...baseInput, lastBarVisible: false })).toBe(-3);
  });

  test('points PREPENDED (leftShifted) → addedToRight false → no compensation', () => {
    expect(compensateRightOffset({ ...baseInput, leftShifted: true, shiftVisibleRangeOnNewBar: false })).toBe(0);
  });

  test('whitespace replacement: no shift unless allow flag set', () => {
    // replacedWhitespace blocks the shift → wantShift false → compensate
    expect(
      compensateRightOffset({ ...baseInput, replacedWhitespace: true }),
    ).toBe(-3);
    // ...but allowing whitespace-replacement shift makes wantShift true → follow
    expect(
      compensateRightOffset({ ...baseInput, replacedWhitespace: true, allowShiftVisibleRangeOnWhitespaceReplacement: true }),
    ).toBe(0);
  });

  test('null new base index: nothing added (no null > n evaluation) → no change', () => {
    expect(compensateRightOffset({ ...baseInput, newBaseIndex: null, shiftVisibleRangeOnNewBar: false })).toBe(0);
  });

  test('no points added (newBase == oldBase) → no compensation', () => {
    expect(compensateRightOffset({ ...baseInput, newBaseIndex: 99, shiftVisibleRangeOnNewBar: false })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rightOffsetPixels px↔bars normalization (design 02 §5.3.4).
// ---------------------------------------------------------------------------
describe('rightOffsetPixels normalization (design 02 §5.3.4)', () => {
  test('set / option apply: offset(bars) = px / S', () => {
    // 60 px at S=6 → 10 bars
    expect(rightOffsetFromPixels(60, 6)).toBe(10);
  });

  test('zoom: offset ← offset · S / S′ keeps the pixel gap constant (applied only when S>0)', () => {
    // 10 bars at S=6 = 60 px; zoom to S′=12 → 5 bars = still 60 px
    expect(rightOffsetForPixels(10, 6, 12)).toBe(5);
    // guard on the OLD-spacing numerator: oldS = 0 leaves the offset unchanged
    expect(rightOffsetForPixels(10, 0, 12)).toBe(10);
  });

  test('fitContent: S = (W − px) / N, then offset = px / S', () => {
    // W=800, px=80, N=100 → S = 720/100 = 7.2 ; offset = 80/7.2
    const { barSpacing, rightOffset } = fitContentWithPixels(800, 80, 100);
    expect(barSpacing).toBeCloseTo(7.2, 9);
    expect(rightOffset).toBeCloseTo(80 / 7.2, 9);
  });

  test('reset / restore-default: offset = px / S0 (configured spacing being restored)', () => {
    // px=30, restored S0=6 → 5 bars
    expect(rightOffsetFromPixels(30, 6)).toBe(5);
  });

  test('configured px=0 normalizes to 0 bars (indistinguishable from rightOffset:0)', () => {
    expect(rightOffsetFromPixels(0, 6)).toBe(0);
  });
});

// helper mirrored from the navigator's fit math (kept local so the test names the contract)
import { fitContentWithPixels } from './navigator';

// ---------------------------------------------------------------------------
// createKineticAnimation — GOLDEN (study 07 §4.11 + §13.13 ε/barSpacing FIX).
// ---------------------------------------------------------------------------
describe('createKineticAnimation closed-form decay (study 07 §4.11)', () => {
  test('positionAt(t0) == launch position', () => {
    const t = kineticTuningForBarSpacing(6);
    const a = createKineticAnimation(100, 0.5 / 6, 1000, t);
    expect(a.positionAt(1000)).toBeCloseTo(100, 9);
  });

  test('GOLDEN duration & position for a fixed (speed, tuning) — barSpacing 6', () => {
    // v0 in BARS/ms = (3 px/ms) / S=6 = 0.5 ; D = 0.997 ; ε = 1px/6 = 0.16666…
    const tuning = kineticTuningForBarSpacing(6);
    expect(tuning.damping).toBe(0.997);
    expect(tuning.epsilon).toBeCloseTo(1 / 6, 12);

    const v0 = 3 / 6; // bars/ms
    const a = createKineticAnimation(100, v0, 0, tuning);

    const lnD = Math.log(0.997);
    // duration = ln( ε·(−lnD)/|v| ) / lnD
    const expectedDuration = Math.log((tuning.epsilon * -lnD) / Math.abs(v0)) / lnD;
    // total travel = |v0| / (−lnD)
    const totalTravel = Math.abs(v0) / -lnD;

    // not finished before the duration, finished at/after it
    expect(a.finished(0)).toBe(false);
    expect(a.finished(expectedDuration - 1)).toBe(false);
    expect(a.finished(expectedDuration)).toBe(true);
    expect(a.finished(expectedDuration + 100)).toBe(true);

    // position integral p(Δt) = p0 + v0·(D^Δt − 1)/lnD ; at duration ≈ rest
    const pAtEnd = a.positionAt(expectedDuration);
    expect(pAtEnd).toBeCloseTo(100 + totalTravel - tuning.epsilon, 6);

    // a known mid-point sample (Δt = 200 ms)
    const pMid = 100 + (v0 * (Math.pow(0.997, 200) - 1)) / lnD;
    expect(a.positionAt(200)).toBeCloseTo(pMid, 9);
  });

  test('§13.13 FIX: with per-pixel ε the fling duration is INVARIANT to barSpacing', () => {
    // Same physical 3 px/ms fling at two zoom levels. The fix divides ε by S
    // alongside the speed, so ε/|v| (hence the duration) is independent of S —
    // the fling travels the same *pixel* distance regardless of zoom. The BUG
    // (ε left at 1 bar) would instead make the large-spacing fling stop a whole
    // bar early (shorter duration), the visible early cut-off study 07 §5 flags.
    const lnD = Math.log(0.997);
    const durAt = (S: number): number => {
      const t = kineticTuningForBarSpacing(S);
      const v = 3 / S; // bars/ms for a 3 px/ms physical fling
      return Math.log((t.epsilon * -lnD) / Math.abs(v)) / lnD;
    };
    expect(durAt(60)).toBeCloseTo(durAt(6), 9); // FIXED: equal

    // Demonstrate the bug would differ: ε held at 1 *bar* at the wide spacing.
    const vWide = 3 / 60;
    const buggyWideDur = Math.log((1 /* bar, NOT /S */ * -lnD) / Math.abs(vWide)) / lnD;
    expect(buggyWideDur).toBeLessThan(durAt(60)); // bug stops earlier

    // both fixed-ε animations report finished exactly at their own duration
    const slow = createKineticAnimation(0, 3 / 6, 0, kineticTuningForBarSpacing(6));
    const wide = createKineticAnimation(0, 3 / 60, 0, kineticTuningForBarSpacing(60));
    expect(slow.finished(durAt(6))).toBe(true);
    expect(wide.finished(durAt(60))).toBe(true);
  });

  test('degenerate: total travel below ε ⇒ negative duration ⇒ finished immediately', () => {
    // tiny velocity, huge ε: |v|/(−lnD) < ε
    const tuning = { damping: 0.997, epsilon: 1000 };
    const a: HorzAnimation = createKineticAnimation(50, 0.0001, 0, tuning);
    expect(a.finished(0)).toBe(true);
  });

  test('named constants match the spec of record (design 04 §7, study 07)', () => {
    expect(KINETIC.minSpeed).toBe(0.2);
    expect(KINETIC.maxSpeed).toBe(7);
    expect(KINETIC.damping).toBe(0.997);
    expect(KINETIC.minMove).toBe(15);
    expect(KINETIC.maxStartDelay).toBe(50);
    expect(KINETIC.epsilonPx).toBe(1);
  });
});
