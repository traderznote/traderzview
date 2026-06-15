// traderzview · extras/watermark — the image watermark plugin (design 05 §2.7 item 3;
// study 08 §4.6 is the placement spec of record). createImageWatermark attaches a PANE-
// attached IPrimitive that registers ONE BelowSeries-band SceneSource (target 'pane', so
// it sits under all series by BAND, not the reference's "pane primitives draw first"
// rule). The image is decoded in the plugin's own layer (extras may touch DOM), handed to
// the backend ONCE via ctx.images.create at load (study 08 §4.6 / design 05 §2.2 item 5),
// then drawn as a centered, padded, fit-scaled media-space `image` command. onload pushes
// the real dimensions and calls requestUpdate('render'); detach disposes the handle.
// applyOptions live-updates through the §12.4 adapter. Built ONLY on the public api seams
// (IPrimitive/PrimitiveContext/ImageHandle + the pane attach surface) + gfx + the extras/
// shared adapter — never model/views (arch §3.1).
import { DisplayListBuilder, ZBand } from '../../gfx';
import type { DisplayList, ImageHandle, SceneSource, ViewFrame } from '../../gfx';
import type { DeepPartial } from '../../core';
import { createPrimitiveAdapter } from '../shared';
import type { PrimitiveAdapter, PrimitiveTarget } from '../shared';
import type { IPrimitive, PrimitiveContext } from '../../api';

// --- public option shape (study 08 §4.6 defaults; kept) -----------------------------

/** Plugin options (standard §5.1 merge via the adapter). `imageUrl` is the source handed
 *  to the loader; `padding` insets each axis; `maxWidth`/`maxHeight` cap the available box
 *  (0 = no cap, study 08 §4.6); `alpha` is the draw globalAlpha (default 1). */
export interface ImageWatermarkOptions {
  visible: boolean;
  imageUrl: string;
  padding: number;
  maxWidth: number;
  maxHeight: number;
  alpha: number;
}

export const imageWatermarkDefaults: ImageWatermarkOptions = {
  visible: true,
  imageUrl: '',
  padding: 0,
  maxWidth: 0,
  maxHeight: 0,
  alpha: 1,
};

/** The §12.4 adapter handle: { detach, applyOptions } (no factory-specific methods). */
export type ImageWatermarkHandle = PrimitiveAdapter<ImageWatermarkOptions>;

/** The pane geometry the source reads through the public seam — `ctx.pane.size()`. */
interface PaneLike {
  size(): { width: number; height: number };
}

/** The loaded image the source draws: a backend handle (its `.size` is the natural px). */
interface LoadedImage {
  readonly handle: ImageHandle;
}

const EMPTY: readonly DisplayList[] = [];

// --- the SceneSource: the §4.6 centered, padded, fit-scaled placement ----------------

function createWatermarkSource(
  getOptions: () => ImageWatermarkOptions,
  getPane: () => PaneLike | null,
  getImage: () => LoadedImage | null,
  getRev: () => number,
): SceneSource {
  const builder = new DisplayListBuilder();
  let cached: readonly DisplayList[] = EMPTY;
  let sig: string | null = null;

  function build(): readonly DisplayList[] {
    const opts = getOptions();
    const img = getImage();
    const pane = getPane();
    if (!opts.visible || img === null || pane === null) return EMPTY;
    const { width: paneW, height: paneH } = pane.size();
    const naturalW = img.handle.size.width;
    const naturalH = img.handle.size.height;
    // Zero-size pane or unloaded image (natural 0) draws nothing (study 08 §4.6 gotcha):
    // the scale math would yield non-finite/zero and nothing useful is drawn.
    if (paneW <= 0 || paneH <= 0 || naturalW <= 0 || naturalH <= 0) return EMPTY;

    // available = paneSize − 2·padding, each axis clamped by maxWidth/maxHeight if set.
    let availW = paneW - 2 * opts.padding;
    let availH = paneH - 2 * opts.padding;
    if (opts.maxWidth > 0) availW = Math.min(availW, opts.maxWidth);
    if (opts.maxHeight > 0) availH = Math.min(availH, opts.maxHeight);
    if (availW <= 0 || availH <= 0) return EMPTY;

    // scale = min(availW/naturalW, availH/naturalH) — MAY upscale; not clamped to 1.
    const scale = Math.min(availW / naturalW, availH / naturalH);
    const drawW = naturalW * scale;
    const drawH = naturalH * scale;
    // Centered: x = round(paneW/2) − drawW/2, y = round(paneH/2) − drawH/2 (study 08 §4.6).
    const x = Math.round(paneW / 2) - drawW / 2;
    const y = Math.round(paneH / 2) - drawH / 2;

    builder.reset();
    builder.beginList('media'); // resolution-independent (the backend scales by hr/vr)
    builder.image(
      img.handle,
      { x: 0, y: 0, width: naturalW, height: naturalH },
      { x, y, width: drawW, height: drawH },
      opts.alpha,
    );
    return builder.finish();
  }

  return {
    zBand: ZBand.BelowSeries, // under all series by band (design 05 §2.7 item 3 / §2.3)
    update(_frame: ViewFrame): void {
      const sz = getPane()?.size();
      const img = getImage();
      // The option revision (bumped on every applyOptions/onChange/image load) forces a
      // rebuild even when pane size + load state are unchanged (a padding/alpha/url edit).
      const next = `${getRev()}|${sz?.width}|${sz?.height}|${img !== null}`;
      if (next === sig) return;
      sig = next;
      cached = build();
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
  };
}

// --- the image loader: DOM decode → ctx.images.create once at onload (study 08 §4.6) ---

/** Minimal source-with-onload the loader drives — an HTMLImageElement structurally.
 *  `extras` runs in the browser context (arch §3.1), so DOM is available; this slice keeps
 *  the plugin testable headless (a stub element fires `onload` synchronously). */
interface LoadableSource {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  complete?: boolean;
  naturalWidth?: number;
}

/** Construct the source element. Real browsers use `new Image()`; absent a DOM (headless),
 *  the caller-injected `createSource` is used. */
function defaultCreateSource(): LoadableSource {
  // eslint-disable-next-line no-undef
  return new Image() as unknown as LoadableSource;
}

// --- the factory (design 02 §12.4: createImageWatermark(pane, imageUrl|options?)) ------

/**
 * Attach an image-watermark primitive to `pane`. Returns the §12.4 adapter handle
 * (`{ detach, applyOptions }`). The adapter attaches on construction and schedules the
 * first Render frame (§2.2); the image is decoded in the plugin's own layer and uploaded
 * to the backend ONCE via `ctx.images.create` when it loads — onload pushes the real
 * dimensions and calls `requestUpdate('render')` (study 08 §4.6 / design 05 §2.2 item 5).
 * `applyOptions` live-merges padding/alpha/url and re-fits; auto-detach (pane removal /
 * chart.dispose) funnels through the same idempotent teardown, which DISPOSES the image
 * handle (a leaked handle dies with its primitive, §2.2 item 5).
 *
 * `createSource` is an injection seam for headless tests (a stub element that fires onload
 * synchronously); production omits it and the plugin uses `new Image()`.
 */
export function createImageWatermark(
  pane: PrimitiveTarget & PaneLike,
  options?: string | DeepPartial<ImageWatermarkOptions>,
  createSource: () => LoadableSource = defaultCreateSource,
): ImageWatermarkHandle {
  // The adapter owns the §5.1 merge; we keep a mutable mirror for the source to read.
  let opts: ImageWatermarkOptions = resolve(options);
  let rev = 0; // bumps on every option change / image load so the source re-fits.

  let ctx: PrimitiveContext | null = null;
  let loaded: LoadedImage | null = null;
  let el: LoadableSource | null = null; // the live loader element (one per imageUrl)
  let elUrl: string | null = null; // the url the current element is loading

  const source = createWatermarkSource(
    () => opts,
    () => (ctx?.pane as unknown as PaneLike | undefined) ?? pane,
    () => loaded,
    () => rev,
  );

  /** Dispose the current backend handle (reaped on detach / url change). */
  function disposeHandle(): void {
    loaded?.handle.dispose();
    loaded = null;
  }

  /** (Re)start the DOM decode for the current `imageUrl`. Idempotent for a url already in
   *  flight or loaded. On load: ctx.images.create ONCE → handle → bump rev → requestUpdate. */
  function startLoad(): void {
    const url = opts.imageUrl;
    if (url === elUrl) return; // already loading / loaded this url
    elUrl = url;
    disposeHandle(); // a url change drops the prior upload
    if (el !== null) {
      el.onload = null;
      el.onerror = null;
      el = null;
    }
    if (url === '' || ctx === null) return; // nothing to load (or not yet attached)
    const element = createSource();
    el = element;
    element.onload = (): void => {
      if (element !== el || ctx === null) return; // superseded / detached
      // The ONE upload: hand the loaded source to the backend, get the sized handle.
      loaded = { handle: ctx.images.create(element) };
      rev++;
      ctx.requestUpdate('render');
    };
    element.onerror = (): void => {
      if (element !== el) return;
      el = null; // give up on this element; a later url change can retry
    };
    element.src = url;
    // A cached image may already be complete: fire the load path immediately.
    if (element.complete === true && (element.naturalWidth ?? 0) > 0) element.onload?.();
  }

  const primitive: IPrimitive = {
    attached(c): void {
      ctx = c as unknown as PrimitiveContext;
      startLoad(); // now that ctx.images exists, kick the decode
    },
    detached(): void {
      if (el !== null) {
        el.onload = null;
        el.onerror = null;
      }
      el = null;
      elUrl = null;
      disposeHandle(); // reap the upload — a leaked handle dies with its primitive (§2.2)
      ctx = null;
    },
    sources(): readonly { target: 'pane'; source: SceneSource }[] {
      return [{ target: 'pane', source }];
    },
  };

  return createPrimitiveAdapter<ImageWatermarkOptions>({
    target: pane,
    primitive,
    options: opts,
    defaults: imageWatermarkDefaults,
    onChange(next): void {
      const urlChanged = next.imageUrl !== opts.imageUrl;
      opts = next;
      rev++;
      if (urlChanged) startLoad(); // a new url re-decodes + re-uploads
      ctx?.requestUpdate('render'); // a BelowSeries base-layer band → a Render frame
    },
    methods: {},
    onDetach(): void {
      // detached() (above) runs on detachPrimitive; this guards the explicit-detach path
      // before the primitive is unregistered, so the handle is reaped even if the binding
      // never calls detached() (belt-and-braces for the §2.2 exactly-once teardown).
      if (el !== null) {
        el.onload = null;
        el.onerror = null;
      }
      el = null;
      elUrl = null;
      disposeHandle();
    },
  });
}

/** Merge the initial source over the kept defaults. A bare string is shorthand for
 *  `{ imageUrl }` (standard §5.1 shallow resolve — leaves replace, never element-merge). */
function resolve(options?: string | DeepPartial<ImageWatermarkOptions>): ImageWatermarkOptions {
  if (options === undefined) return { ...imageWatermarkDefaults };
  const patch: DeepPartial<ImageWatermarkOptions> =
    typeof options === 'string' ? { imageUrl: options } : options;
  return {
    visible: patch.visible ?? imageWatermarkDefaults.visible,
    imageUrl: patch.imageUrl ?? imageWatermarkDefaults.imageUrl,
    padding: patch.padding ?? imageWatermarkDefaults.padding,
    maxWidth: patch.maxWidth ?? imageWatermarkDefaults.maxWidth,
    maxHeight: patch.maxHeight ?? imageWatermarkDefaults.maxHeight,
    alpha: patch.alpha ?? imageWatermarkDefaults.alpha,
  };
}
