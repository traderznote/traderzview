import { describe, expect, test } from 'vitest';
import { CanvasBinding, predictBitmapSize, type BitmapObserver } from './binding';
import { MockCanvas } from './mock-context.test';

// A controllable observer standing in for ResizeObserver(device-pixel-content-box)
// or the matchMedia DPR observable. The test drives discovered sizes directly.
class FakeObserver implements BitmapObserver {
  readonly reprediction: boolean;
  #cb: ((w: number, h: number) => void) | undefined;
  disposed = false;
  constructor(reprediction: boolean) {
    this.reprediction = reprediction;
  }
  start(cb: (w: number, h: number) => void): void {
    this.#cb = cb;
  }
  // Test hook: simulate a discovery (RO entry or DPR-change prediction).
  emit(w: number, h: number): void {
    this.#cb?.(w, h);
  }
  dispose(): void {
    this.disposed = true;
  }
}

function makeBinding(reprediction: boolean): {
  binding: CanvasBinding;
  canvas: MockCanvas;
  obs: FakeObserver;
  fired: number;
} {
  const canvas = new MockCanvas();
  const obs = new FakeObserver(reprediction);
  const binding = new CanvasBinding(canvas as unknown as HTMLCanvasElement, obs);
  let fired = 0;
  binding.resolutionChanged.subscribe(() => fired++);
  return {
    binding,
    canvas,
    obs,
    get fired() {
      return fired;
    },
  } as never;
}

describe('predictBitmapSize (matchMedia fallback formula, study 05 §3.2)', () => {
  test('snaps both physical edges and takes the difference', () => {
    // rect at left=10.4, width=100, dpr=2 → round(20.8+200)−round(20.8)=round(220.8)−round(20.8)=221−21=200
    const s = predictBitmapSize({ left: 10.4, top: 0, width: 100, height: 50 }, 2);
    expect(s.width).toBe(221 - 21);
    expect(s.height).toBe(100);
  });
  test('handles fractional DPR (110% zoom ≈ 1.1)', () => {
    const s = predictBitmapSize({ left: 0, top: 0, width: 100, height: 100 }, 1.1);
    expect(s.width).toBe(Math.round(110) - 0);
    expect(s.height).toBe(110);
  });
});

describe('CanvasBinding setMediaSize', () => {
  test('writes style width/height in px on the canvas (never reads layout back)', () => {
    const { binding, canvas } = makeBinding(false);
    binding.setMediaSize({ width: 300, height: 150 });
    expect(canvas.style.width).toBe('300px');
    expect(canvas.style.height).toBe('150px');
  });
});

describe('CanvasBinding suggest/apply lifecycle (design 03 §8.2)', () => {
  test('a discovered size becomes a suggestion and fires resolutionChanged; canvas NOT yet resized', () => {
    const { binding, canvas, obs } = makeBinding(false);
    binding.setMediaSize({ width: 300, height: 150 });
    let fired = 0;
    binding.resolutionChanged.subscribe(() => fired++);
    obs.emit(600, 300);
    expect(fired).toBe(1);
    expect(binding.suggestedBitmapSize).toEqual({ width: 600, height: 300 });
    expect(canvas.width).toBe(0); // NOT applied yet — apply only at beginFrame('full')
  });

  test('discovered size is clamped per-dimension to ≥ client size (sub-1-DPR / transient-0 guard)', () => {
    const { binding, obs } = makeBinding(false);
    binding.setMediaSize({ width: 300, height: 150 });
    obs.emit(100, 50); // smaller than client → clamp up
    expect(binding.suggestedBitmapSize).toEqual({ width: 300, height: 150 });
  });

  test('applySuggested() writes canvas.width/height and clears the suggestion; returns the bitmap size', () => {
    const { binding, canvas, obs } = makeBinding(false);
    binding.setMediaSize({ width: 300, height: 150 });
    obs.emit(600, 300);
    const applied = binding.applySuggested();
    expect(applied).toEqual({ width: 600, height: 300 });
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(300);
    expect(binding.suggestedBitmapSize).toBeUndefined();
  });

  test('applySuggested() is a no-op (returns current bitmap) when there is no pending suggestion', () => {
    const { binding, obs } = makeBinding(false);
    binding.setMediaSize({ width: 300, height: 150 });
    obs.emit(600, 300);
    binding.applySuggested();
    const again = binding.applySuggested();
    expect(again).toEqual({ width: 600, height: 300 });
  });

  test('a discovery equal to the current bitmap size produces no new suggestion / no fire', () => {
    const { binding, obs } = makeBinding(false);
    binding.setMediaSize({ width: 300, height: 150 });
    obs.emit(600, 300);
    binding.applySuggested();
    let fired = 0;
    binding.resolutionChanged.subscribe(() => fired++);
    obs.emit(600, 300); // same as applied → no change
    expect(fired).toBe(0);
    expect(binding.suggestedBitmapSize).toBeUndefined();
  });
});

describe('CanvasBinding matchMedia re-prediction on setMediaSize (fallback path only)', () => {
  test('fallback path: a pure CSS resize re-predicts the bitmap and fires resolutionChanged', () => {
    const canvas = new MockCanvas();
    const obs = new FakeObserver(true); // reprediction = matchMedia fallback
    const binding = new CanvasBinding(canvas as unknown as HTMLCanvasElement, obs, () => 2, () => ({
      left: 0,
      top: 0,
      width: canvas.style.width ? parseFloat(canvas.style.width) : 0,
      height: canvas.style.height ? parseFloat(canvas.style.height) : 0,
    }));
    let fired = 0;
    binding.resolutionChanged.subscribe(() => fired++);
    binding.setMediaSize({ width: 300, height: 150 }); // re-predicts → 600×300 suggestion
    expect(fired).toBe(1);
    expect(binding.suggestedBitmapSize).toEqual({ width: 600, height: 300 });
  });

  test('RO path: setMediaSize does NOT re-predict (the observer fires on the CSS resize directly)', () => {
    const canvas = new MockCanvas();
    const obs = new FakeObserver(false); // RO path
    const binding = new CanvasBinding(canvas as unknown as HTMLCanvasElement, obs, () => 2);
    let fired = 0;
    binding.resolutionChanged.subscribe(() => fired++);
    binding.setMediaSize({ width: 300, height: 150 });
    expect(fired).toBe(0);
    expect(binding.suggestedBitmapSize).toBeUndefined();
  });
});

describe('CanvasBinding dispose (iOS canvas-memory cap, kept)', () => {
  test('shrinks the canvas to 1×1, clears it, and disposes the observer', () => {
    const { binding, canvas, obs } = makeBinding(false);
    binding.setMediaSize({ width: 300, height: 150 });
    obs.emit(600, 300);
    binding.applySuggested();
    binding.dispose();
    expect(canvas.width).toBe(1);
    expect(canvas.height).toBe(1);
    expect(canvas.ctx.ops('clearRect').length).toBeGreaterThan(0);
    expect(obs.disposed).toBe(true);
  });
});
