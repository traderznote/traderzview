import { describe, expect, test } from 'vitest';
import type { BitmapObserver } from './binding';
import { makeBackend, type BackendEnv } from './index';
import { MockCanvas } from './mock-context.test';

class NoopObserver implements BitmapObserver {
  readonly reprediction = false;
  start(): void {}
  dispose(): void {}
}

// A MockCanvas augmented with the DOM bits the factory touches.
class DomMockCanvas extends MockCanvas {
  removed = false;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { left: 0, top: 0, width: this.width, height: this.height };
  }
  remove(): void {
    this.removed = true;
  }
}

class MockMount {
  readonly children: DomMockCanvas[] = [];
  appendChild(c: DomMockCanvas): void {
    this.children.push(c);
  }
}

function fakeEnv(): { env: BackendEnv; created: DomMockCanvas[] } {
  const created: DomMockCanvas[] = [];
  const env: BackendEnv = {
    createCanvas: () => {
      const c = new DomMockCanvas();
      created.push(c);
      return c as unknown as HTMLCanvasElement;
    },
    makeObserver: () => new NoopObserver(),
    getDpr: () => 2,
  };
  return { env, created };
}

describe('canvasBackend factory (design 03 §8.1)', () => {
  test('exposes a text measurer backed by a hidden measuring canvas', () => {
    const { env } = fakeEnv();
    const backend = makeBackend(env);
    const r = backend.text.measure('ABC', { family: 'Arial', size: 12 });
    expect(r.width).toBe(21); // mock measureText = len*7
  });

  test('createSurface builds two stacked canvases on the mount (base z1, overlay z2)', () => {
    const { env, created } = fakeEnv();
    const backend = makeBackend(env);
    const mount = new MockMount();
    const surface = backend.createSurface(mount as unknown as HTMLElement);
    // 1 measuring canvas + 2 surface canvases
    expect(created.length).toBe(3);
    expect(mount.children.length).toBe(2);
    expect(mount.children[0].style.zIndex).toBe('1');
    expect(mount.children[1].style.zIndex).toBe('2');
    expect(mount.children[0].style.position).toBe('absolute');
    expect(mount.children[0].style.pointerEvents).toBe('none');
    expect(surface).toBeDefined();
  });

  test('the surface drives a real frame end-to-end against the mocks', () => {
    const { env } = fakeEnv();
    const backend = makeBackend(env);
    const mount = new MockMount();
    const surface = backend.createSurface(mount as unknown as HTMLElement);
    surface.setMediaSize({ width: 100, height: 50 });
    const fi = surface.beginFrame('full');
    expect(fi.mediaSize).toEqual({ width: 100, height: 50 });
    surface.endFrame();
  });

  test('createImage wraps a source and reports its natural size', () => {
    const { env } = fakeEnv();
    const backend = makeBackend(env);
    const handle = backend.createImage({ naturalWidth: 64, naturalHeight: 32 } as unknown as CanvasImageSource);
    expect(handle.size).toEqual({ width: 64, height: 32 });
  });

  test('composeSnapshot produces a Snapshot at mediaSize × dpr', () => {
    const { env, created } = fakeEnv();
    const backend = makeBackend(env);
    const snap = backend.composeSnapshot([], { width: 80, height: 40 });
    expect(snap).toBeDefined();
    const out = created[created.length - 1];
    expect(out.width).toBe(160); // 80 × dpr(2)
    expect(out.height).toBe(80);
  });

  test('dispose shrinks the measuring canvas to 1×1', () => {
    const { env, created } = fakeEnv();
    const backend = makeBackend(env);
    backend.dispose();
    expect(created[0].width).toBe(1); // the measuring canvas is the first created
  });

  test('surface.dispose removes its canvases from the mount', () => {
    const { env } = fakeEnv();
    const backend = makeBackend(env);
    const mount = new MockMount();
    const surface = backend.createSurface(mount as unknown as HTMLElement);
    surface.dispose();
    expect(mount.children.every((c) => c.removed)).toBe(true);
  });
});
