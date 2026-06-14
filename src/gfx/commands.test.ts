import { describe, expect, test } from 'vitest';
import { dashPattern, LineStyle, PathVerb } from './commands';

describe('dashPattern — dash table (study 05 §4.4), multiples of line width w', () => {
  test('one pattern per style', () => {
    expect(dashPattern(LineStyle.Solid, 2)).toEqual([]);
    expect(dashPattern(LineStyle.Dotted, 2)).toEqual([2, 2]);
    expect(dashPattern(LineStyle.Dashed, 2)).toEqual([4, 4]);
    expect(dashPattern(LineStyle.LargeDashed, 2)).toEqual([12, 12]);
    expect(dashPattern(LineStyle.SparseDotted, 2)).toEqual([2, 8]);
  });
});

describe('LineStyle / PathVerb — erasable const-objects (enum syntax forbidden by erasableSyntaxOnly)', () => {
  test('enum-like member access', () => {
    expect(LineStyle.Solid).toBe(0);
    expect(LineStyle.Dotted).toBe(1);
    expect(LineStyle.SparseDotted).toBe(4);
    expect(PathVerb.Move).toBe(0);
    expect(PathVerb.Line).toBe(1);
    expect(PathVerb.Close).toBe(2);
  });
});
