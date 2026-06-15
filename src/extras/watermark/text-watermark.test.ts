// Spec of record: study 08 §4.5 (text watermark — per-line shrink-to-fit zoom, the two-
// pass layout, horz/vert alignment incl. the right offset's −1, vertOffset clamp at 0) +
// design 05 §2.7 item 3 (pane-attached, BelowSeries band, ownerKind = pane) + §2.2
// (lifecycle: attach schedules a frame; detach idempotent + exactly-once; detached()
// once on auto-detach). HEADLESS: a recording PrimitiveTarget pane + a stub Primitive-
// Context over the PUBLIC api types — no DOM, no model, no real chart. Every position is
// hand-derived from the §4.5 layout with the plugin's deterministic width estimate
// (len × fontSize × 0.6) and ascent share (fontSize × 0.8).
import { describe, expect, test } from 'vitest';
import { ZBand } from '../../gfx';
import type { DisplayList, SceneSource, TextCommand, ViewFrame } from '../../gfx';
import type { IPrimitive } from '../../api';
import { createTextWatermark, textWatermarkDefaults } from './text-watermark';

// --- a recording pane: PrimitiveTarget + the size() slice the source reads -----------
function makePane(width = 600, height = 400) {
  const attached: IPrimitive[] = [];
  const detached: IPrimitive[] = [];
  return {
    attached,
    detached,
    width,
    height,
    size(): { width: number; height: number } {
      return { width: this.width, height: this.height };
    },
    attachPrimitive(p: IPrimitive): void {
      attached.push(p);
    },
    detachPrimitive(p: IPrimitive): void {
      detached.push(p);
    },
  };
}

// A stub PrimitiveContext: records requestUpdate scopes; `pane.size()` mirrors the pane.
function makeCtx(pane: ReturnType<typeof makePane>) {
  const updates: string[] = [];
  return {
    updates,
    requestUpdate(scope: 'overlay' | 'render' | 'layout'): void {
      updates.push(scope);
    },
    pane: { size: () => pane.size() },
  };
}

const frame = (): ViewFrame => ({
  now: 0,
  frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 },
});

function getSource(primitive: IPrimitive): SceneSource {
  const srcs = primitive.sources?.() ?? [];
  expect(srcs.length).toBe(1);
  return srcs[0]!.source as unknown as SceneSource;
}

// Build, attach the context, and pull the registered source.
function attach(
  pane: ReturnType<typeof makePane>,
  ctx: ReturnType<typeof makeCtx>,
  opts?: Parameters<typeof createTextWatermark>[1],
): { handle: ReturnType<typeof createTextWatermark>; primitive: IPrimitive; source: SceneSource } {
  const handle = createTextWatermark(pane, opts);
  const primitive = pane.attached[0]!;
  primitive.attached?.(ctx as never);
  return { handle, primitive, source: getSource(primitive) };
}

// The single text command the source emits (after update).
function textItems(source: SceneSource): TextCommand['items'] {
  const lists = source.displayLists() as readonly DisplayList[];
  if (lists.length === 0) return [];
  expect(lists[0]!.space).toBe('media'); // resolution-independent (study 08 §2)
  const cmd = lists[0]!.commands.find((c) => c.kind === 'text') as TextCommand | undefined;
  return cmd?.items ?? [];
}

describe('createTextWatermark — lifecycle (design 05 §2.2 / §2.7)', () => {
  test('construction attaches exactly one primitive to the pane (the §2.2 attach)', () => {
    const pane = makePane();
    createTextWatermark(pane);
    expect(pane.attached.length).toBe(1);
    expect(pane.detached.length).toBe(0);
  });

  test('the primitive registers ONE pane source on the BelowSeries band (§2.7 item 3)', () => {
    const pane = makePane();
    createTextWatermark(pane, { lines: [{ text: 'X', color: '#000', fontSize: 12 }] });
    const primitive = pane.attached[0]!;
    const srcs = primitive.sources!();
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.target).toBe('pane');
    expect((srcs[0]!.source as unknown as SceneSource).zBand).toBe(ZBand.BelowSeries);
  });

  test('detach() detaches exactly once; double-detach is a no-op (§2.2)', () => {
    const pane = makePane();
    const ctx = makeCtx(pane);
    const { handle, primitive } = attach(pane, ctx);
    handle.detach();
    expect(pane.detached).toEqual([primitive]);
    handle.detach();
    handle.detach();
    expect(pane.detached).toEqual([primitive]); // still exactly one
  });

  test('detached() drops the captured context (auto-detach lifecycle, §2.2)', () => {
    const pane = makePane();
    const ctx = makeCtx(pane);
    const { handle, primitive } = attach(pane, ctx, {
      lines: [{ text: 'X', color: '#000', fontSize: 12 }],
    });
    // simulate auto-detach: the host calls detached() once on pane removal / dispose.
    primitive.detached?.();
    // after detached(), an option change must NOT reach a (now-null) context.
    ctx.updates.length = 0;
    handle.applyOptions({ visible: false });
    expect(ctx.updates).toEqual([]); // no requestUpdate after detached() (context dropped)
  });
});

describe('createTextWatermark — defaults + visibility', () => {
  test('default options are visible center/center with no lines (study 08 §4.5)', () => {
    expect(textWatermarkDefaults).toEqual({
      visible: true,
      horzAlign: 'center',
      vertAlign: 'center',
      lines: [],
    });
  });

  test('no lines → nothing drawn (empty display list)', () => {
    const pane = makePane();
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx);
    source.update(frame());
    expect(source.displayLists().length).toBe(0);
  });

  test('visible:false → nothing drawn even with lines', () => {
    const pane = makePane();
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      visible: false,
      lines: [{ text: 'HIDDEN', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    expect(source.displayLists().length).toBe(0);
  });

  test('a zero-size pane draws nothing (study 08 §4.5 guard)', () => {
    const pane = makePane(0, 0);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      lines: [{ text: 'X', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    expect(source.displayLists().length).toBe(0);
  });
});

describe('createTextWatermark — §4.5 layout (hand-derived; w = len·fontSize·0.6)', () => {
  test('a single center/center line is centered with the right baseline', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      lines: [{ text: 'ABC', color: '#ff0000', fontSize: 48 }],
    });
    source.update(frame());
    const items = textItems(source);
    expect(items.length).toBe(1);
    // w = 3·48·0.6 = 86.4 ; zoom = 1 (86.4 ≤ 600) ; lineHeight = 57.6 ; total = 57.6
    // vertOffset(center) = max((400−57.6)/2,0) = 171.2 ; baseline += 48·0.8 = 38.4
    // x(center) = 600/2 − 86.4/2 = 256.8 ; y = 171.2 + 38.4 = 209.6
    expect(items[0]!.x).toBeCloseTo(256.8, 5);
    expect(items[0]!.y).toBeCloseTo(209.6, 5);
    expect(items[0]!.font.size).toBeCloseTo(48, 5);
    expect(items[0]!.color).toBe('#ff0000');
  });

  test("horzAlign 'left' anchors at lineHeight/2; 'right' uses width − 1 − lineHeight/2 − w", () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const left = attach(pane, ctx, {
      horzAlign: 'left',
      lines: [{ text: 'ABC', color: '#000', fontSize: 48 }],
    });
    left.source.update(frame());
    // lineHeight = 57.6 → x(left) = 57.6/2 = 28.8
    expect(textItems(left.source)[0]!.x).toBeCloseTo(28.8, 5);

    const pane2 = makePane(600, 400);
    const ctx2 = makeCtx(pane2);
    const right = attach(pane2, ctx2, {
      horzAlign: 'right',
      lines: [{ text: 'ABC', color: '#000', fontSize: 48 }],
    });
    right.source.update(frame());
    // x(right) = 600 − 1 − 57.6/2 − 86.4 = 600 − 1 − 28.8 − 86.4 = 483.8
    expect(textItems(right.source)[0]!.x).toBeCloseTo(483.8, 5);
  });

  test("vertAlign 'top' starts at 0; 'bottom' anchors total height to the bottom", () => {
    const pane = makePane(600, 400);
    const ctxTop = makeCtx(pane);
    const top = attach(pane, ctxTop, {
      vertAlign: 'top',
      lines: [{ text: 'ABC', color: '#000', fontSize: 48 }],
    });
    top.source.update(frame());
    // vertOffset(top) = 0 → y = 0 + 38.4 = 38.4
    expect(textItems(top.source)[0]!.y).toBeCloseTo(38.4, 5);

    const pane2 = makePane(600, 400);
    const ctxBot = makeCtx(pane2);
    const bottom = attach(pane2, ctxBot, {
      vertAlign: 'bottom',
      lines: [{ text: 'ABC', color: '#000', fontSize: 48 }],
    });
    bottom.source.update(frame());
    // vertOffset(bottom) = max(400 − 57.6, 0) = 342.4 → y = 342.4 + 38.4 = 380.8
    expect(textItems(bottom.source)[0]!.y).toBeCloseTo(380.8, 5);
  });

  test('multiple lines stack by line height (top-aligned, hand-derived)', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      vertAlign: 'top',
      horzAlign: 'left',
      lines: [
        { text: 'AB', color: '#111', fontSize: 20 },
        { text: 'CD', color: '#222', fontSize: 30 },
      ],
    });
    source.update(frame());
    const items = textItems(source);
    expect(items.length).toBe(2);
    // line 1: lineHeight = 24 ; y = 0 + 20·0.8 = 16 ; x = 24/2 = 12
    expect(items[0]!.y).toBeCloseTo(16, 5);
    expect(items[0]!.x).toBeCloseTo(12, 5);
    // line 2 starts after line1 height (24): y = 24 + 30·0.8 = 48 ; x = (30·1.2)/2 = 18
    expect(items[1]!.y).toBeCloseTo(48, 5);
    expect(items[1]!.x).toBeCloseTo(18, 5);
  });

  test('a line wider than the pane SHRINKS (zoom < 1); a fitting line never enlarges', () => {
    const pane = makePane(60, 400); // narrow pane forces shrink
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      horzAlign: 'center',
      vertAlign: 'top',
      lines: [{ text: 'WIDE', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    const items = textItems(source);
    // w = 4·48·0.6 = 115.2 > 60 → zoom = 60/115.2 = 0.520833…
    const zoom = 60 / (4 * 48 * 0.6);
    expect(items[0]!.font.size).toBeCloseTo(48 * zoom, 5); // shrunk fitted size
    // scaled width = 115.2·zoom = 60 (fills) → x(center) = 60/2 − 60/2 = 0
    expect(items[0]!.x).toBeCloseTo(0, 5);
  });

  test('an empty-text line contributes its height but emits no text item (study 08 §4.5)', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      vertAlign: 'top',
      horzAlign: 'left',
      lines: [
        { text: '', color: '#000', fontSize: 20 }, // empty: 24px gap, no draw
        { text: 'XY', color: '#000', fontSize: 20 },
      ],
    });
    source.update(frame());
    const items = textItems(source);
    expect(items.length).toBe(1); // only the non-empty line draws
    // it starts after the empty line's 24px height: y = 24 + 20·0.8 = 40
    expect(items[0]!.y).toBeCloseTo(40, 5);
  });
});

describe('createTextWatermark — applyOptions live-update through the §12.4 adapter', () => {
  test('applyOptions replaces lines and re-lays out; requests a Render frame', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { handle, source } = attach(pane, ctx, {
      lines: [{ text: 'OLD', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    expect(textItems(source)[0]!.color).toBe('#000');

    ctx.updates.length = 0;
    handle.applyOptions({ lines: [{ text: 'NEW', color: '#abcabc', fontSize: 48 }] });
    expect(ctx.updates).toContain('render'); // onChange asked for a Render frame
    source.update(frame()); // rev bumped → the source re-lays out even at same line count
    expect(textItems(source)[0]!.color).toBe('#abcabc');
  });

  test('toggling visible:false through applyOptions clears the drawn text', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { handle, source } = attach(pane, ctx, {
      lines: [{ text: 'SHOW', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    expect(textItems(source).length).toBe(1);
    handle.applyOptions({ visible: false });
    source.update(frame());
    expect(source.displayLists().length).toBe(0);
  });

  test('a no-op applyOptions patch does not request a frame (§5.1 unchanged = no-op)', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { handle } = attach(pane, ctx, {
      lines: [{ text: 'A', color: '#000', fontSize: 48 }],
    });
    ctx.updates.length = 0;
    handle.applyOptions({ visible: true }); // already true → no change
    expect(ctx.updates).toEqual([]);
  });
});
