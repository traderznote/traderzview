import { describe, expect, test } from 'vitest';
import { HitPriority } from './hit';
import { ZBand } from './scene';

describe('ZBand / HitPriority — erasable const-objects (z-order / arbitration)', () => {
  test('ZBand bands span base + overlay in draw order', () => {
    expect(ZBand.Background).toBe(0);
    expect(ZBand.Grid).toBe(1);
    expect(ZBand.Series).toBe(3);
    expect(ZBand.Labels).toBe(5);
    expect(ZBand.Crosshair).toBe(6);
    expect(ZBand.Cursor).toBe(8);
  });

  test('HitPriority orders Range < Line < Point', () => {
    expect(HitPriority.Range).toBe(0);
    expect(HitPriority.Line).toBe(1);
    expect(HitPriority.Point).toBe(2);
  });
});
