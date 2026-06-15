// traderzview · backend-canvas — the ONLY module that touches a
// CanvasRenderingContext2D. Imports core + gfx only (never model/views/data); DOM
// types are allowed (it owns canvases). The factory wires the module surface: per
// pane/axis/stub a mount div with two stacked canvases (base + overlay), a binding
// per canvas, a CanvasSurface; createImage wraps a CanvasImageSource; composeSnapshot
// flattens screenshot tiles; `text` is a hidden-context ITextMeasurer. See
// dev-docs/design/03-rendering-backend-spec.md §8.
import type { Size } from '../core';
import type {
  ImageHandle,
  IRenderBackend,
  ISurface,
  Snapshot,
  SnapshotTile,
  ITextMeasurer,
} from '../gfx';
import { CanvasBinding } from './binding';
import { composeSnapshot, createCanvasImage } from './image';
import { devicePixelRatio, makeBitmapObserver } from './observer';
import { CanvasSurface } from './surface';
import { CanvasTextMeasurer } from './text';

export interface CanvasBackendOptions {
  colorSpace?: PredefinedColorSpace; // default 'srgb'; per-backend, NOT per-paint
}

/**
 * Injection seam for the DOM bits, so the factory is unit-testable headless. The
 * public canvasBackend() builds the real-DOM env; tests pass a fake one.
 */
export interface BackendEnv {
  createCanvas(): HTMLCanvasElement;
  makeObserver(canvas: HTMLCanvasElement): import('./binding').BitmapObserver;
  getDpr(): number;
}

const domEnv: BackendEnv = {
  createCanvas: () => document.createElement('canvas'),
  makeObserver: makeBitmapObserver,
  getDpr: devicePixelRatio,
};

function styleLayer(canvas: HTMLCanvasElement, zIndex: number): void {
  const s = canvas.style;
  s.position = 'absolute';
  s.left = '0';
  s.top = '0';
  s.zIndex = String(zIndex);
  s.pointerEvents = 'none'; // input is the host's mount element, not the canvases
}

/** Internal factory over an injected env (design 03 §8.1). */
export function makeBackend(env: BackendEnv, options?: CanvasBackendOptions): IRenderBackend<HTMLElement, CanvasImageSource> {
  const colorSpace: PredefinedColorSpace = options?.colorSpace ?? 'srgb';

  // One hidden measuring context for the whole backend (no measure-during-paint).
  const measureCanvas = env.createCanvas();
  const measureCtx = measureCanvas.getContext('2d', { colorSpace });
  // measureCtx is non-null on every real engine; the cast keeps headless mocks happy.
  const text: ITextMeasurer = new CanvasTextMeasurer(measureCtx as CanvasRenderingContext2D);

  function createSurface(mount: HTMLElement): ISurface {
    const baseCanvas = env.createCanvas();
    const overlayCanvas = env.createCanvas();
    styleLayer(baseCanvas, 1);
    styleLayer(overlayCanvas, 2);
    mount.appendChild(baseCanvas);
    mount.appendChild(overlayCanvas);

    const baseBinding = new CanvasBinding(baseCanvas, env.makeObserver(baseCanvas), env.getDpr, () => {
      const r = baseCanvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    const overlayBinding = new CanvasBinding(overlayCanvas, env.makeObserver(overlayCanvas), env.getDpr, () => {
      const r = overlayCanvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    return new CanvasSurface({
      baseCanvas,
      overlayCanvas,
      baseBinding,
      overlayBinding,
      createCanvas: env.createCanvas,
      colorSpace,
      onDispose: () => {
        baseCanvas.remove();
        overlayCanvas.remove();
      },
    });
  }

  function createImage(source: CanvasImageSource): ImageHandle {
    return createCanvasImage(source);
  }

  // `includeCrosshair` is an optional extra arg (default true in composeSnapshot): the
  // IRenderBackend contract is composeSnapshot(tiles, mediaSize), and a (tiles, mediaSize)
  // call is structurally assignable to this wider signature, so callers that don't pass
  // the flag get the crosshair-included screenshot. The host's screenshot orchestration
  // forwards it when an `includeCrosshair: false` screenshot is requested (§8.6).
  function snapshot(tiles: readonly SnapshotTile[], mediaSize: Size, includeCrosshair?: boolean): Snapshot {
    return composeSnapshot(tiles, mediaSize, env.getDpr(), env.createCanvas, includeCrosshair);
  }

  return {
    createSurface,
    createImage,
    composeSnapshot: snapshot,
    text,
    dispose: () => {
      // Drop the measuring canvas (iOS canvas-memory cap, kept).
      measureCanvas.width = 1;
      measureCanvas.height = 1;
    },
  };
}

/** Public Canvas 2D backend factory (design 03 §8.1). */
export function canvasBackend(options?: CanvasBackendOptions): IRenderBackend<HTMLElement, CanvasImageSource> {
  return makeBackend(domEnv, options);
}
