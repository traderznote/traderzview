import { describe, expect, test } from 'vitest';
import type { DisplayList, RectsCommand } from '../gfx';
import { LineStyle, PathVerb } from '../gfx';
import { GradientCache } from './gradient';
import { isCopyFastPath, replayLists } from './replay';
import { MockContext } from './mock-context.test';

const W = 200;
const H = 100;

function ctxOf(): { ctx: MockContext; cache: GradientCache } {
  return { ctx: new MockContext(), cache: new GradientCache() };
}
function render(lists: readonly DisplayList[]): MockContext {
  const { ctx, cache } = ctxOf();
  replayLists(ctx as unknown as CanvasRenderingContext2D, lists, W, H, 2, 2, cache);
  return ctx;
}

function fullQuad(): RectsCommand {
  return { kind: 'rects', coords: new Float32Array([0, 0, W, H]), runs: [{ count: 1, fill: '#101010' }] };
}
function bitmapList(...commands: RectsCommand[]): DisplayList {
  return { space: 'bitmap', commands };
}

describe('copy fast-path predicate (design 03 §8.3, exactly)', () => {
  test('holds for a SINGLE bitmap list, one full-bitmap unstroked unrounded rects, no clip', () => {
    expect(isCopyFastPath([bitmapList(fullQuad())], W, H)).toBe(true);
  });

  test('fails when there are multiple lists', () => {
    expect(isCopyFastPath([bitmapList(fullQuad()), bitmapList(fullQuad())], W, H)).toBe(false);
  });

  test('fails with a list-level clip', () => {
    expect(
      isCopyFastPath([{ space: 'bitmap', clip: { x: 0, y: 0, width: W, height: H }, commands: [fullQuad()] }], W, H),
    ).toBe(false);
  });

  test('fails for a media-space list', () => {
    expect(isCopyFastPath([{ space: 'media', commands: [fullQuad()] }], W, H)).toBe(false);
  });

  test('fails for a rounded quad', () => {
    expect(isCopyFastPath([bitmapList({ ...fullQuad(), radius: 4 })], W, H)).toBe(false);
  });

  test('fails for a stroked quad', () => {
    expect(isCopyFastPath([bitmapList({ ...fullQuad(), stroke: { width: 1, color: '#fff' } })], W, H)).toBe(false);
  });

  test('fails for a non-full quad (offset or wrong size)', () => {
    expect(isCopyFastPath([bitmapList({ ...fullQuad(), coords: new Float32Array([1, 0, W, H]) })], W, H)).toBe(false);
    expect(isCopyFastPath([bitmapList({ ...fullQuad(), coords: new Float32Array([0, 0, W - 1, H]) })], W, H)).toBe(
      false,
    );
  });

  test('fails for multi-quad rects (two quads)', () => {
    expect(
      isCopyFastPath([bitmapList({ kind: 'rects', coords: new Float32Array([0, 0, W, H, 0, 0, W, H]), runs: [{ count: 2, fill: '#000' }] })], W, H),
    ).toBe(false);
  });

  test("fails when the first command is not 'rects'", () => {
    const text: DisplayList = { space: 'media', commands: [{ kind: 'text', items: [] }] };
    expect(isCopyFastPath([text], W, H)).toBe(false);
  });

  test('fails when the single list has more than one command (the 2nd would be dropped)', () => {
    expect(isCopyFastPath([bitmapList(fullQuad(), fullQuad())], W, H)).toBe(false);
  });

  test('fails for a full quad with empty runs (guards the prod runs[0] deref)', () => {
    expect(isCopyFastPath([bitmapList({ ...fullQuad(), runs: [] })], W, H)).toBe(false);
  });
});

describe('replay: clear vs copy', () => {
  test('copy fast-path skips clearRect and fills with globalCompositeOperation = copy', () => {
    const ctx = render([bitmapList(fullQuad())]);
    expect(ctx.ops('clearRect')).toHaveLength(0);
    const fr = ctx.ops('fillRect');
    expect(fr).toHaveLength(1);
    expect(fr[0].args).toEqual([0, 0, W, H, '#101010', 'copy']);
  });

  test('ordinary path clears the whole bitmap then replays the rects normally', () => {
    const ctx = render([bitmapList(fullQuad()), bitmapList(fullQuad())]);
    expect(ctx.ops('clearRect')[0].args).toEqual([0, 0, W, H]);
    // ordinary rects use beginPath/rect/fill, not fillRect+copy
    expect(ctx.ops('fill').length).toBeGreaterThan(0);
  });
});

describe('replay: transforms per space', () => {
  test('bitmap list uses resetTransform (identity); media list uses setTransform(hr,0,0,vr,0,0)', () => {
    const { ctx, cache } = ctxOf();
    const media: DisplayList = { space: 'media', commands: [{ kind: 'text', items: [] }] };
    const bmp = bitmapList(fullQuad(), fullQuad()); // 2 commands so it's not copy path
    replayLists(ctx as unknown as CanvasRenderingContext2D, [bmp, media], W, H, 1.5, 2.5, cache);
    expect(ctx.ops('resetTransform').length).toBeGreaterThan(0);
    expect(ctx.ops('setTransform').some((e) => JSON.stringify(e.args) === JSON.stringify([1.5, 0, 0, 2.5, 0, 0]))).toBe(
      true,
    );
  });

  test('a list-level clip is converted ×(hr,vr) for bitmap lists and applied via rect()+clip()', () => {
    const { ctx, cache } = ctxOf();
    const list: DisplayList = {
      space: 'bitmap',
      clip: { x: 10, y: 5, width: 20, height: 8 },
      commands: [fullQuad(), fullQuad()],
    };
    replayLists(ctx as unknown as CanvasRenderingContext2D, [list], W, H, 2, 3, cache);
    const clipRect = ctx.ops('rect').find((e) => JSON.stringify(e.args) === JSON.stringify([20, 15, 40, 24]));
    expect(clipRect).toBeDefined();
    expect(ctx.ops('clip')).toHaveLength(1);
  });
});

describe('replay: rects', () => {
  test('unrounded rects: one beginPath/rect-per-quad/fill per run', () => {
    const list = bitmapList({
      kind: 'rects',
      coords: new Float32Array([0, 0, 5, 5, 10, 0, 5, 5, 20, 0, 5, 5]),
      runs: [
        { count: 2, fill: '#aaa' },
        { count: 1, fill: '#bbb' },
      ],
    });
    // two lists so we don't take the copy fast path
    const ctx = render([list, bitmapList(fullQuad())]);
    expect(ctx.ops('beginPath').length).toBeGreaterThanOrEqual(2);
    const fills = ctx.ops('fill');
    expect(fills.some((e) => e.args[0] === '#aaa')).toBe(true);
    expect(fills.some((e) => e.args[0] === '#bbb')).toBe(true);
  });

  test('rounded rects use roundRect with the radius', () => {
    const list = bitmapList({ kind: 'rects', coords: new Float32Array([1, 2, 3, 4]), runs: [{ count: 1, fill: '#f0f' }], radius: 3 });
    const ctx = render([list, bitmapList(fullQuad())]);
    expect(ctx.ops('roundRect')[0].args).toEqual([1, 2, 3, 4, 3]);
  });

  test('stroke pass runs after fills, once, with the StrokeSpec width/color', () => {
    const list = bitmapList({
      kind: 'rects',
      coords: new Float32Array([0, 0, 10, 10]),
      runs: [{ count: 1, fill: '#123' }],
      stroke: { width: 2, color: '#456' },
    });
    const ctx = render([list, bitmapList(fullQuad())]);
    const strokes = ctx.ops('stroke');
    expect(strokes).toHaveLength(1);
    expect(strokes[0].args).toEqual(['#456', 2, 0]); // strokeStyle, lineWidth, dashOffset
  });

  test('a stroke pass resets lineJoin/lineCap so a prior polyline does not leak (§3.1)', () => {
    const list: DisplayList = {
      space: 'bitmap',
      commands: [
        { kind: 'polyline', points: new Float32Array([0, 0, 10, 10]), runs: [{ count: 2, fill: '#999' }], width: 2, style: LineStyle.Solid, join: 'round' },
        { kind: 'rects', coords: new Float32Array([0, 0, 10, 10]), runs: [{ count: 1, fill: '#111' }], stroke: { width: 1, color: '#222' } },
      ],
    };
    const ctx = render([list]);
    expect(ctx.lineJoin).toBe('miter'); // reset by applyStroke — not the polyline's 'round'
    expect(ctx.lineCap).toBe('butt');
  });
});

describe('replay: polyline', () => {
  test('butt cap, lineJoin and lineWidth set; gaps lift the pen (moveTo after NaN)', () => {
    const list: DisplayList = {
      space: 'bitmap',
      commands: [
        {
          kind: 'polyline',
          points: new Float32Array([0, 0, 10, 10, NaN, NaN, 20, 20, 30, 30]),
          runs: [{ count: 5, fill: '#999' }],
          width: 2,
          style: LineStyle.Solid,
          join: 'round',
        },
      ],
    };
    const ctx = render([list]);
    expect(ctx.lineCap).toBe('butt');
    expect(ctx.lineJoin).toBe('round');
    // moveTo at the start AND after the gap → 2 moveTos
    expect(ctx.ops('moveTo')).toHaveLength(2);
  });

  test('segment-styling: a run is stroked with a one-vertex extension into the next run', () => {
    // 4 vertices, run A = [v0,v1], run B = [v2,v3]. Run A must stroke v0,v1,v2 (extension).
    const list: DisplayList = {
      space: 'bitmap',
      commands: [
        {
          kind: 'polyline',
          points: new Float32Array([0, 0, 1, 1, 2, 2, 3, 3]),
          runs: [
            { count: 2, fill: '#a' },
            { count: 2, fill: '#b' },
          ],
          width: 1,
          style: LineStyle.Solid,
          join: 'miter',
        },
      ],
    };
    const ctx = render([list]);
    // run A: moveTo(0,0) lineTo(1,1) lineTo(2,2)  → the extension vertex (2,2) is included
    const lineTos = ctx.ops('lineTo').map((e) => e.args);
    expect(lineTos).toContainEqual([2, 2]);
    expect(ctx.ops('stroke').some((e) => e.args[0] === '#a')).toBe(true);
    expect(ctx.ops('stroke').some((e) => e.args[0] === '#b')).toBe(true);
  });

  test('dash continuity: dashOffset accumulates across runs within one polyline', () => {
    // horizontal line, two runs, dashed. Run A length = 10, so run B starts at offset 10 % patternLen.
    const list: DisplayList = {
      space: 'bitmap',
      commands: [
        {
          kind: 'polyline',
          points: new Float32Array([0, 0, 10, 0, 30, 0]),
          runs: [
            { count: 1, fill: '#a' },
            { count: 2, fill: '#b' },
          ],
          width: 1,
          style: LineStyle.Dashed, // pattern [2,2], patternLen 4
          join: 'miter',
        },
      ],
    };
    const ctx = render([list]);
    const strokes = ctx.ops('stroke');
    // run A starts at offset 0; run B starts at offset (segment A length 10) % 4 = 2
    const a = strokes.find((e) => e.args[0] === '#a');
    const b = strokes.find((e) => e.args[0] === '#b');
    expect(a?.args[2]).toBe(0);
    expect(b?.args[2]).toBe(2);
  });
});

describe('replay: area', () => {
  test('closes each segment down to baseY and fills once', () => {
    const list: DisplayList = {
      space: 'media',
      commands: [{ kind: 'area', points: new Float32Array([0, 50, 10, 40, 20, 45]), baseY: 100, fill: '#0f0' }],
    };
    const ctx = render([list]);
    const lineTos = ctx.ops('lineTo').map((e) => e.args);
    expect(lineTos).toContainEqual([20, 100]); // lastX → baseY
    expect(lineTos).toContainEqual([0, 100]); // firstX → baseY
    expect(ctx.ops('closePath')).toHaveLength(1);
    expect(ctx.ops('fill')).toHaveLength(1);
  });
});

describe('replay: circles', () => {
  test('fill runs then an optional ring stroke; runs:[] draws no fill', () => {
    const list: DisplayList = {
      space: 'bitmap',
      commands: [
        { kind: 'circles', coords: new Float32Array([5, 5, 3]), runs: [], stroke: { width: 1, color: '#ddd' } },
      ],
    };
    const ctx = render([list]);
    expect(ctx.ops('arc')[0].args).toEqual([5, 5, 3, 0, Math.PI * 2]);
    expect(ctx.ops('fill')).toHaveLength(0); // empty runs → no fill
    expect(ctx.ops('stroke')).toHaveLength(1);
  });
});

describe('replay: path', () => {
  test('walks verbs and fills (nonzero) then strokes', () => {
    const list: DisplayList = {
      space: 'bitmap',
      commands: [
        {
          kind: 'path',
          verbs: new Uint8Array([PathVerb.Move, PathVerb.Line, PathVerb.Line, PathVerb.Close]),
          points: new Float32Array([0, 0, 5, 0, 5, 5]),
          fill: '#abc',
          stroke: { width: 1, color: '#def' },
        },
      ],
    };
    const ctx = render([list]);
    expect(ctx.ops('moveTo')[0].args).toEqual([0, 0]);
    expect(ctx.ops('lineTo').map((e) => e.args)).toEqual([
      [5, 0],
      [5, 5],
    ]);
    expect(ctx.ops('closePath')).toHaveLength(1);
    expect(ctx.ops('fill')[0].args[0]).toBe('#abc');
    expect(ctx.ops('stroke')[0].args[0]).toBe('#def');
  });
});

describe('replay: text', () => {
  test('fixed left/alphabetic; font set per FontSpec; fillText per item', () => {
    const list: DisplayList = {
      space: 'media',
      commands: [
        {
          kind: 'text',
          items: [
            { x: 1, y: 2, text: 'Hi', font: { family: 'Arial', size: 12 }, color: '#111' },
            { x: 3, y: 4, text: 'Yo', font: { family: 'Arial', size: 12 }, color: '#222' },
          ],
        },
      ],
    };
    const ctx = render([list]);
    expect(ctx.textAlign).toBe('left');
    expect(ctx.textBaseline).toBe('alphabetic');
    const ft = ctx.ops('fillText');
    expect(ft[0].args.slice(0, 3)).toEqual(['Hi', 1, 2]);
    expect(ft[1].args.slice(0, 3)).toEqual(['Yo', 3, 4]);
  });
});
