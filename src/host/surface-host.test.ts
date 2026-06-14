import { describe, expect, test, vi } from 'vitest';
import { SurfaceHost, type HostElement, type SurfaceConfig, type SurfaceFactory } from './surface-host';
import { PaneScene } from '../views';
import { UpdateLevel } from '../model';
import { Emitter } from '../core';
import type { FrameInfo, FrameScope, LayerId, DisplayList, SurfaceSnapshot } from '../gfx';

// --- fakes (headless: no real DOM, no real backend) --------------------------------

function fakeElement(): HostElement {
  const style = { position: '', left: '', top: '', width: '', height: '' };
  return {
    style,
    appendChild: vi.fn(),
    removeChild: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }),
  };
}

// A recording ISurface: logs the begin/render/end call sequence and the size writes.
function fakeSurface() {
  const calls: string[] = [];
  const resolutionChanged = new Emitter();
  let media = { width: 0, height: 0 };
  const surface = {
    setMediaSize(s: { width: number; height: number }) {
      media = { ...s };
      calls.push(`setMediaSize(${s.width},${s.height})`);
    },
    beginFrame(scope: FrameScope): FrameInfo {
      calls.push(`beginFrame(${scope})`);
      return { mediaSize: media, bitmapSize: media, hr: 1, vr: 1 };
    },
    renderLayer(layer: LayerId, _lists: readonly DisplayList[]) {
      calls.push(`renderLayer(${layer})`);
    },
    endFrame() {
      calls.push('endFrame');
    },
    resolutionChanged,
    snapshot(): SurfaceSnapshot {
      calls.push('snapshot');
      return { _tag: 'SurfaceSnapshot' };
    },
    dispose() {
      calls.push('dispose');
    },
  };
  return { surface, calls, resolutionChanged };
}

function makeHost(kind: SurfaceConfig['kind'] = 'pane', onRes: () => void = () => {}) {
  const { surface, calls, resolutionChanged } = fakeSurface();
  const factory: SurfaceFactory = { createSurface: () => surface };
  const scene = new PaneScene();
  const el = fakeElement();
  const sh = new SurfaceHost(el, factory, { kind, scene }, onRes);
  return { sh, calls, scene, el, resolutionChanged };
}

describe('SurfaceHost — rect/size application (study 10 §3.1)', () => {
  test('setRect writes the absolute box and the media size; 0-area ⇒ invisible', () => {
    const { sh, calls, el } = makeHost();
    sh.setRect({ x: 10, y: 20, width: 300, height: 200 });
    expect(el.style.position).toBe('absolute');
    expect(el.style.left).toBe('10px');
    expect(el.style.top).toBe('20px');
    expect(el.style.width).toBe('300px');
    expect(el.style.height).toBe('200px');
    expect(calls).toContain('setMediaSize(300,200)');
    expect(sh.visible()).toBe(true);

    sh.setRect({ x: 0, y: 0, width: 0, height: 200 });
    expect(sh.visible()).toBe(false);
  });
});

describe('SurfaceHost — paint call sequence per UpdateLevel (rendering-backend §6)', () => {
  test('Overlay → beginFrame(overlay) → renderLayer(overlay) → endFrame', () => {
    const { sh, calls } = makeHost();
    sh.setRect({ x: 0, y: 0, width: 100, height: 100 });
    const afterSize = calls.length;
    sh.paint(UpdateLevel.Overlay, 5);
    expect(calls.slice(afterSize)).toEqual(['beginFrame(overlay)', 'renderLayer(overlay)', 'endFrame']);
  });

  test('Render → beginFrame(full) → renderLayer(base) → renderLayer(overlay) → endFrame', () => {
    const { sh, calls } = makeHost();
    sh.setRect({ x: 0, y: 0, width: 100, height: 100 });
    const afterSize = calls.length;
    sh.paint(UpdateLevel.Render, 5);
    expect(calls.slice(afterSize)).toEqual([
      'beginFrame(full)',
      'renderLayer(base)',
      'renderLayer(overlay)',
      'endFrame',
    ]);
  });

  test('Layout paints "as Render" (full + both layers) — sizes are applied by the host first', () => {
    const { sh, calls } = makeHost();
    sh.setRect({ x: 0, y: 0, width: 100, height: 100 });
    const afterSize = calls.length;
    sh.paint(UpdateLevel.Layout, 5);
    expect(calls.slice(afterSize)).toEqual([
      'beginFrame(full)',
      'renderLayer(base)',
      'renderLayer(overlay)',
      'endFrame',
    ]);
  });

  test('an invisible surface and a None level both no-op', () => {
    const { sh, calls } = makeHost();
    const before = calls.length;
    sh.paint(UpdateLevel.Render, 5); // never sized ⇒ invisible
    expect(calls.length).toBe(before);

    sh.setRect({ x: 0, y: 0, width: 100, height: 100 });
    const after = calls.length;
    sh.paint(UpdateLevel.None, 5);
    expect(calls.length).toBe(after);
  });
});

describe('SurfaceHost — resolutionChanged + dispose', () => {
  test('a resolutionChanged fire invokes the host callback (→ coalescing Layout mask)', () => {
    const onRes = vi.fn();
    const { resolutionChanged } = makeHost('pane', onRes);
    resolutionChanged.fire();
    expect(onRes).toHaveBeenCalledTimes(1);
  });

  test('dispose drops the surface and the resolution subscription stops firing', () => {
    const onRes = vi.fn();
    const { sh, calls, resolutionChanged } = makeHost('pane', onRes);
    sh.dispose();
    expect(calls).toContain('dispose');
    resolutionChanged.fire();
    expect(onRes).not.toHaveBeenCalled();
  });
});
