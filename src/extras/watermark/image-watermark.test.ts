// Spec of record: study 08 §4.6 (image watermark placement — available = paneSize −
// 2·padding clamped by maxWidth/maxHeight; scale = min(availW/naturalW, availH/naturalH),
// MAY upscale; draw centered at round(paneW/2)−drawW/2; globalAlpha = alpha; zero-size /
// unloaded draws nothing) + design 05 §2.7 item 3 (pane-attached, BelowSeries band, ONE
// ctx.images.create upload at load) + §2.2 (lifecycle: attach schedules a frame; the
// onload pushes dimensions + requestUpdate; detach idempotent + exactly-once + the handle
// is reaped) + design 02 §12 / §12.4 (the public IPrimitive seam + {detach, applyOptions}).
// HEADLESS: a recording PrimitiveTarget pane + a stub PrimitiveContext (its images.create
// returns a sized, disposable handle) + an injected loader element that fires onload
// synchronously — no DOM, no model, no browser. Every assertion is hand-derived.
import { describe, expect, test, vi } from 'vitest';
import { ZBand } from '../../gfx';
import type { DrawCommand, ImageCommand, ImageHandle, SceneSource, ViewFrame } from '../../gfx';
import type { IPrimitive } from '../../api';
import { createImageWatermark, imageWatermarkDefaults } from './image-watermark';

// --- a recording pane: PrimitiveTarget + the size() slice the source reads ------------
function makePane(width = 400, height = 300) {
  const attached: IPrimitive[] = [];
  const detached: IPrimitive[] = [];
  return {
    attached,
    detached,
    size(): { width: number; height: number } {
      return { width, height };
    },
    attachPrimitive(p: IPrimitive): void {
      attached.push(p);
    },
    detachPrimitive(p: IPrimitive): void {
      detached.push(p);
    },
  };
}

// A backend ImageHandle stub: a fixed natural size + a recorded, idempotent dispose.
function makeHandle(width: number, height: number): ImageHandle & { disposed: number } {
  let disposed = 0;
  return {
    size: { width, height },
    dispose(): void {
      disposed++;
    },
    get disposed(): number {
      return disposed;
    },
  } as ImageHandle & { disposed: number };
}

// A stub PrimitiveContext: records requestUpdate scopes; images.create returns the next
// queued handle (so a test controls the natural size) and records each upload.
function makeCtx(pane: ReturnType<typeof makePane>, handles: Array<ImageHandle & { disposed: number }>) {
  const updates: string[] = [];
  const uploads: unknown[] = [];
  let i = 0;
  const ctx = {
    updates,
    uploads,
    requestUpdate(scope: 'overlay' | 'render' | 'layout'): void {
      updates.push(scope);
    },
    pane,
    images: {
      create(src: unknown): ImageHandle {
        uploads.push(src);
        return handles[i++]!;
      },
    },
  };
  return ctx;
}

// An injected loader element: NOT auto-complete; a test calls fireLoad() to fire onload.
function makeLoader() {
  const elements: StubEl[] = [];
  interface StubEl {
    src: string;
    onload: (() => void) | null;
    onerror: (() => void) | null;
    complete: boolean;
    naturalWidth: number;
  }
  const create = (): StubEl => {
    const el: StubEl = { src: '', onload: null, onerror: null, complete: false, naturalWidth: 0 };
    elements.push(el);
    return el;
  };
  return {
    elements,
    create: create as unknown as () => never,
    fireLoad(n = elements.length - 1): void {
      elements[n]!.onload?.();
    },
  };
}

const frame = (w = 400, h = 300): ViewFrame =>
  ({
    now: 0,
    frame: { mediaSize: { width: w, height: h }, bitmapSize: { width: w, height: h }, hr: 1, vr: 1 },
  }) as unknown as ViewFrame;

function sourceOf(pane: ReturnType<typeof makePane>): SceneSource {
  const prim = pane.attached[0] as { sources(): ReadonlyArray<{ target: string; source: SceneSource }> };
  return prim.sources()[0]!.source;
}

function imageCmd(src: SceneSource): ImageCommand | null {
  const cmds = src.displayLists().flatMap((l) => l.commands as DrawCommand[]);
  return (cmds.find((c) => c.kind === 'image') as ImageCommand | undefined) ?? null;
}

// Full wiring: a pane, a ctx with a queued natural size, an injected loader. The handle is
// uploaded only once fireLoad() runs.
function setup(opts?: Parameters<typeof createImageWatermark>[1], natural: [number, number] = [200, 100]) {
  const pane = makePane();
  const handles = [makeHandle(natural[0], natural[1]), makeHandle(natural[0], natural[1])];
  const ctx = makeCtx(pane, handles);
  const loader = makeLoader();
  const handle = createImageWatermark(pane, opts ?? { imageUrl: 'logo.png' }, loader.create);
  const primitive = pane.attached[0]!;
  primitive.attached?.(ctx as never);
  return { pane, ctx, loader, handle, primitive, handles, source: sourceOf(pane) };
}

describe('createImageWatermark — lifecycle (design 05 §2.2 / §2.7)', () => {
  test('construction attaches exactly one primitive to the pane (the §2.2 attach)', () => {
    const { pane } = setup();
    expect(pane.attached).toHaveLength(1);
    expect(pane.detached).toHaveLength(0);
  });

  test('the registered source sits in band BelowSeries, target pane (§2.3 / §2.7 item 3)', () => {
    const { pane } = setup();
    const prim = pane.attached[0] as { sources(): ReadonlyArray<{ target: string; source: SceneSource }> };
    const srcs = prim.sources();
    expect(srcs).toHaveLength(1);
    expect(srcs[0]!.target).toBe('pane');
    expect(srcs[0]!.source.zBand).toBe(ZBand.BelowSeries);
  });

  test('detach() is idempotent + exactly-once (§2.2)', () => {
    const { pane, primitive, handle } = setup();
    handle.detach();
    expect(pane.detached).toEqual([primitive]);
    handle.detach();
    handle.detach();
    expect(pane.detached).toHaveLength(1);
  });

  test('detach disposes the uploaded image handle exactly once (a leaked handle dies with it, §2.2)', () => {
    const { loader, handle, handles } = setup();
    loader.fireLoad();
    expect(handles[0]!.disposed).toBe(0);
    handle.detach();
    expect(handles[0]!.disposed).toBe(1);
    handle.detach(); // double-detach reaps nothing more
    expect(handles[0]!.disposed).toBe(1);
  });
});

describe('createImageWatermark — the onload upload lifecycle (study 08 §4.6 / §2.2 item 5)', () => {
  test('before onload nothing is uploaded and nothing is drawn (natural size unknown)', () => {
    const { ctx, source } = setup();
    expect(ctx.uploads).toHaveLength(0);
    source.update(frame());
    expect(imageCmd(source)).toBeNull(); // unloaded → no useful draw (§4.6 gotcha)
  });

  test('onload uploads ONCE via ctx.images.create and requests a render frame', () => {
    const { ctx, loader, source } = setup();
    loader.fireLoad();
    expect(ctx.uploads).toHaveLength(1); // the single backend upload (§2.2 item 5)
    expect(ctx.updates).toContain('render'); // onload → requestUpdate('render')
    source.update(frame());
    expect(imageCmd(source)).not.toBeNull(); // now the natural size is known → drawn
  });

  test('the upload happens at most once even across many frames (no re-upload per frame)', () => {
    const { ctx, loader, source } = setup();
    loader.fireLoad();
    source.update(frame());
    source.update(frame());
    expect(ctx.uploads).toHaveLength(1);
  });
});

describe('createImageWatermark — placement (study 08 §4.6 — centered, padded, fit-scaled)', () => {
  test('fit-scale centers the image in a media-space image command (pane 400×300, img 200×100)', () => {
    // availW=400, availH=300; scale=min(400/200=2, 300/100=3)=2; drawW=400, drawH=200.
    // x=round(200)−200=0; y=round(150)−100=50. alpha=1.
    const { loader, source } = setup();
    loader.fireLoad();
    source.update(frame());
    const cmd = imageCmd(source)!;
    expect(cmd.src).toEqual({ x: 0, y: 0, width: 200, height: 100 });
    expect(cmd.dst).toEqual({ x: 0, y: 50, width: 400, height: 200 });
    expect(cmd.alpha).toBe(1);
    // the list is media-space (resolution-independent; backend scales by hr/vr)
    expect(source.displayLists()[0]!.space).toBe('media');
  });

  test('scale MAY upscale beyond natural size (not clamped to 1) — img 50×50 in 400×300', () => {
    // scale=min(400/50=8, 300/50=6)=6 (>1); drawW=300, drawH=300; x=round(200)−150=50, y=round(150)−150=0.
    const { loader, source } = setup({ imageUrl: 'small.png' }, [50, 50]);
    loader.fireLoad();
    source.update(frame());
    const cmd = imageCmd(source)!;
    expect(cmd.dst).toEqual({ x: 50, y: 0, width: 300, height: 300 });
  });

  test('padding insets the available box on each axis (padding 20)', () => {
    // availW=360, availH=260; scale=min(360/200=1.8, 260/100=2.6)=1.8; drawW=360, drawH=180.
    // x=round(200)−180=20; y=round(150)−90=60.
    const { loader, source } = setup({ imageUrl: 'logo.png', padding: 20 });
    loader.fireLoad();
    source.update(frame());
    expect(imageCmd(source)!.dst).toEqual({ x: 20, y: 60, width: 360, height: 180 });
  });

  test('maxWidth caps the available width (maxWidth 100)', () => {
    // availW=min(400,100)=100, availH=300; scale=min(100/200=0.5, 300/100=3)=0.5; drawW=100, drawH=50.
    // x=round(200)−50=150; y=round(150)−25=125.
    const { loader, source } = setup({ imageUrl: 'logo.png', maxWidth: 100 });
    loader.fireLoad();
    source.update(frame());
    expect(imageCmd(source)!.dst).toEqual({ x: 150, y: 125, width: 100, height: 50 });
  });

  test('alpha is forwarded to the image command globalAlpha', () => {
    const { loader, source } = setup({ imageUrl: 'logo.png', alpha: 0.25 });
    loader.fireLoad();
    source.update(frame());
    expect(imageCmd(source)!.alpha).toBe(0.25);
  });
});

describe('createImageWatermark — degenerate states draw nothing (study 08 §4.6 gotcha)', () => {
  test('visible:false emits no image command even when loaded', () => {
    const { loader, source, handle } = setup();
    loader.fireLoad();
    handle.applyOptions({ visible: false });
    source.update(frame());
    expect(imageCmd(source)).toBeNull();
  });

  test('a zero-size pane draws nothing', () => {
    const pane = makePane(0, 0);
    const handles = [makeHandle(200, 100)];
    const ctx = makeCtx(pane, handles);
    const loader = makeLoader();
    createImageWatermark(pane, { imageUrl: 'logo.png' }, loader.create);
    pane.attached[0]!.attached?.(ctx as never);
    loader.fireLoad();
    const src = sourceOf(pane);
    src.update(frame(0, 0));
    expect(imageCmd(src)).toBeNull();
  });

  test('an empty imageUrl never uploads (nothing to load)', () => {
    const pane = makePane();
    const handles = [makeHandle(200, 100)];
    const ctx = makeCtx(pane, handles);
    const loader = makeLoader();
    createImageWatermark(pane, { imageUrl: '' }, loader.create);
    pane.attached[0]!.attached?.(ctx as never);
    expect(loader.elements).toHaveLength(0);
    expect(ctx.uploads).toHaveLength(0);
  });
});

describe('createImageWatermark — applyOptions live-update (design 02 §12.4 adapter)', () => {
  test('changing padding re-fits next frame (the option revision dirties the source)', () => {
    const { loader, source, handle } = setup();
    loader.fireLoad();
    source.update(frame());
    expect(imageCmd(source)!.dst).toEqual({ x: 0, y: 50, width: 400, height: 200 });
    handle.applyOptions({ padding: 20 });
    source.update(frame());
    expect(imageCmd(source)!.dst).toEqual({ x: 20, y: 60, width: 360, height: 180 });
  });

  test('changing imageUrl re-decodes + re-uploads (a second create), disposing the old handle', () => {
    const { ctx, loader, handle, handles } = setup();
    loader.fireLoad(); // first element loads → first upload
    expect(ctx.uploads).toHaveLength(1);
    handle.applyOptions({ imageUrl: 'other.png' }); // new url → new element, old handle reaped
    expect(handles[0]!.disposed).toBe(1); // the prior upload was disposed on url change
    loader.fireLoad(); // the second element loads → second upload
    expect(ctx.uploads).toHaveLength(2);
  });

  test('a no-op applyOptions patch is skipped (§5.1) — no extra render request', () => {
    const { ctx, loader, handle } = setup();
    loader.fireLoad();
    const before = ctx.updates.length;
    handle.applyOptions({ visible: true }); // already true → merge unchanged → onChange skipped
    expect(ctx.updates.length).toBe(before);
  });
});

describe('createImageWatermark — defaults + string shorthand (design 02 §12.4)', () => {
  test('defaults match the kept reference defaults (study 08 §4.6)', () => {
    expect(imageWatermarkDefaults).toEqual({
      visible: true,
      imageUrl: '',
      padding: 0,
      maxWidth: 0,
      maxHeight: 0,
      alpha: 1,
    });
  });

  test('a bare string argument is shorthand for { imageUrl }', () => {
    const pane = makePane();
    const handles = [makeHandle(200, 100)];
    const ctx = makeCtx(pane, handles);
    const loader = makeLoader();
    createImageWatermark(pane, 'logo.png', loader.create);
    pane.attached[0]!.attached?.(ctx as never);
    expect(loader.elements[0]!.src).toBe('logo.png');
  });
});
