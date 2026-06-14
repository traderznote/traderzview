// traderzview · host/surface-host — the ONE surface widget (architecture §7). A
// mount element + an INJECTED ISurface (gfx) + a PaneScene + the resolutionChanged
// subscription (mapped to one coalescing Layout invalidate, §5.1.6) + rect/size
// application + paint dispatch over the rendering-backend §6 call sequence. Panes,
// price axes, the time axis, and stubs are four thin CONFIGS of this one widget —
// they differ only by surface kind; band convention lives in PaneScene (§6).
import type { Rect, Size, Unsubscribe } from '../core';
import type { FrameScope, ISurface, LayerId, SurfaceSnapshot, ViewFrame } from '../gfx';
import type { PaneScene } from '../views';
import type { SurfaceKind } from './input/types';
import type { UpdateLevel } from '../model';
import { UpdateLevel as Level } from '../model';

/** The few mount-element members the host touches — `HTMLElement` satisfies it, and
 *  a headless test passes a fake that records style writes (no real DOM). */
export interface HostElement {
  readonly style: { position: string; left: string; top: string; width: string; height: string };
  appendChild(child: unknown): void;
  removeChild(child: unknown): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

/** A backend that creates surfaces into mount elements (the injected IRenderBackend,
 *  narrowed to the one method SurfaceHost uses — keeps the file backend-agnostic). */
export interface SurfaceFactory {
  createSurface(mount: HostElement): ISurface;
}

/** One config of the four (pane / price-axis / time-axis / stub). Carries the scene
 *  the host composites and the surface kind the gesture layer reports. */
export interface SurfaceConfig {
  readonly kind: SurfaceKind;
  readonly scene: PaneScene;
}

/**
 * A single surface widget. The host creates one per pane, per price axis, per time
 * axis, and per stub; positions it via `setRect`; and paints it each frame via
 * `paint`. It owns no chart semantics — it routes a PaneScene composite to ISurface.
 */
export class SurfaceHost {
  readonly kind: SurfaceKind;
  readonly #mount: HostElement;
  readonly #surface: ISurface;
  readonly #scene: PaneScene;
  readonly #resCancel: Unsubscribe;
  #rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  #visible = false;

  constructor(mount: HostElement, factory: SurfaceFactory, config: SurfaceConfig, onResolutionChange: () => void) {
    this.#mount = mount;
    this.#scene = config.scene;
    this.kind = config.kind;
    const s = mount.style;
    s.position = 'absolute';
    this.#surface = factory.createSurface(mount);
    // A new suggested bitmap size (DPR / sub-pixel shift) → one coalescing Layout
    // mask (architecture §5.1.6); the host owns the merge + schedule.
    this.#resCancel = this.#surface.resolutionChanged.subscribe(onResolutionChange);
  }

  /** The PaneScene this surface composites (the host registers sources into it). */
  scene(): PaneScene {
    return this.#scene;
  }

  /** Place + size the surface (study 10 §3.1 apply pass): write the absolute box and
   *  hand the media size to the surface. A 0-area rect marks the surface invisible —
   *  it is skipped on paint/screenshot (the degenerate-surface no-op, §5.1.5). */
  setRect(rect: Rect): void {
    this.#rect = rect;
    const s = this.#mount.style;
    s.left = `${rect.x}px`;
    s.top = `${rect.y}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    this.#visible = rect.width > 0 && rect.height > 0;
    this.#surface.setMediaSize({ width: rect.width, height: rect.height } satisfies Size);
  }

  rect(): Rect {
    return this.#rect;
  }

  visible(): boolean {
    return this.#visible;
  }

  /**
   * Paint per the rendering-backend §6 call sequence for the frame's UpdateLevel:
   *   Overlay → beginFrame('overlay') → renderLayer('overlay', composite('overlay'))
   *   Render/Layout → beginFrame('full') → renderLayer('base') → renderLayer('overlay')
   * (Layout rects/sizes are applied by the host BEFORE this — here it is "as Render".)
   * Invisible surfaces are skipped (§5.1.5). `now` drives source animations.
   */
  paint(level: UpdateLevel, now: number): void {
    if (!this.#visible || level === Level.None) return;
    const scope: FrameScope = level === Level.Overlay ? 'overlay' : 'full';
    const info = this.#surface.beginFrame(scope);
    const frame: ViewFrame = { frame: info, now };
    if (scope === 'full') this.#render('base', frame);
    this.#render('overlay', frame);
    this.#surface.endFrame();
  }

  #render(layer: LayerId, frame: ViewFrame): void {
    this.#surface.renderLayer(layer, this.#scene.composite(layer, frame));
  }

  /** A snapshot of the current pixels (screenshot single pass, §7). */
  snapshot(): SurfaceSnapshot {
    return this.#surface.snapshot();
  }

  /** Tear down: drop the resolution subscription and the surface (chart.dispose). */
  dispose(): void {
    this.#resCancel();
    this.#surface.dispose();
  }
}
