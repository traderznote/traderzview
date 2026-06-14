import { describe, expect, test } from 'vitest';
import { DisplayListBuilder } from './builder';
import { LineStyle } from './commands';
import type { PolylineCommand, RectsCommand } from './commands';

const textItem = { x: 0, y: 0, text: 'hi', font: { family: 'sans', size: 10 }, color: '#000' };

describe('DisplayListBuilder', () => {
  test('folds consecutive equal fills into runs; Σ run.count = element count', () => {
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const r = b.rects({});
    r.quad(0, 0, 2, 2, 'red');
    r.quad(2, 0, 2, 2, 'red');
    r.quad(4, 0, 2, 2, 'blue');
    const lists = b.finish();
    expect(lists.length).toBe(1);
    const cmd = lists[0]!.commands[0] as RectsCommand;
    expect(cmd.kind).toBe('rects');
    expect([...cmd.runs]).toEqual([
      { count: 2, fill: 'red' },
      { count: 1, fill: 'blue' },
    ]);
    expect(cmd.coords.length).toBe(12); // 3 quads × 4
  });

  test('emits several lists with their own space', () => {
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    b.rects({}).quad(0, 0, 1, 1, 'red');
    b.beginList('media');
    b.text([textItem]);
    const lists = b.finish();
    expect(lists.length).toBe(2);
    expect(lists[0]!.space).toBe('bitmap');
    expect(lists[1]!.space).toBe('media');
  });

  test('polyline gap writes a NaN pair and counts as a vertex', () => {
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const p = b.polyline(1, LineStyle.Solid, 'miter');
    p.vertex(0, 0, '#fff');
    p.gap();
    p.vertex(10, 10, '#fff');
    const cmd = b.finish()[0]!.commands[0] as PolylineCommand;
    expect(cmd.kind).toBe('polyline');
    expect(cmd.points.length).toBe(6); // 3 vertices × 2
    expect(Number.isNaN(cmd.points[2]!)).toBe(true);
    expect(Number.isNaN(cmd.points[3]!)).toBe(true);
  });

  test('dev assertion: NaN in rects coords throws', () => {
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    expect(() => b.rects({}).quad(Number.NaN, 0, 1, 1, 'red')).toThrow();
  });

  test('dev assertion: negative width throws', () => {
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    expect(() => b.rects({}).quad(0, 0, -1, 1, 'red')).toThrow();
  });

  test('dev assertion: text in a bitmap list throws', () => {
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    expect(() => b.text([textItem])).toThrow();
  });

  test('reuses the geometry backing buffer across reset cycles', () => {
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    b.rects({}).quad(0, 0, 1, 1, 'red');
    const buf1 = (b.finish()[0]!.commands[0] as RectsCommand).coords.buffer;
    b.reset();
    b.beginList('bitmap');
    b.rects({}).quad(0, 0, 1, 1, 'red');
    const buf2 = (b.finish()[0]!.commands[0] as RectsCommand).coords.buffer;
    expect(buf2).toBe(buf1);
  });
});
