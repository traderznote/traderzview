import { describe, expect, test } from 'vitest';
import { captureScreenshot, type SnapshotComposer } from './screenshot';
import type { SurfaceHost } from './surface-host';
import type { Rect, Size } from '../core';
import type { Snapshot, SnapshotTile, SurfaceSnapshot } from '../gfx';

// A surface stub exposing only what captureScreenshot reads (visible/rect/snapshot).
function fakeSurface(rect: Rect, visible: boolean, tag: string): SurfaceHost {
  return {
    visible: () => visible,
    rect: () => rect,
    snapshot: (): SurfaceSnapshot => ({ _tag: 'SurfaceSnapshot', ...(tag ? { id: tag } : {}) } as SurfaceSnapshot),
  } as unknown as SurfaceHost;
}

function recordingComposer() {
  const seen: { tiles: SnapshotTile[]; size: Size; includeCrosshair?: boolean }[] = [];
  const composer: SnapshotComposer = {
    composeSnapshot(tiles, mediaSize, includeCrosshair): Snapshot {
      seen.push({ tiles: [...tiles], size: mediaSize, includeCrosshair });
      return { _tag: 'Snapshot' };
    },
  };
  return { composer, seen };
}

describe('captureScreenshot — single-pass tile collection (architecture §7)', () => {
  test('emits one snapshot tile per VISIBLE surface, then one fill tile per separator', () => {
    const surfaces = [
      fakeSurface({ x: 0, y: 0, width: 100, height: 50 }, true, 'pane0'),
      fakeSurface({ x: 0, y: 51, width: 100, height: 50 }, true, 'pane1'),
      fakeSurface({ x: 0, y: 0, width: 0, height: 0 }, false, 'hidden'), // 0-area ⇒ skipped
    ];
    const separators: Rect[] = [{ x: 0, y: 50, width: 100, height: 1 }];
    const { composer, seen } = recordingComposer();

    const out = captureScreenshot(composer, surfaces, separators, '#abcabc', { width: 100, height: 101 });

    expect(out).toEqual({ _tag: 'Snapshot' });
    expect(seen).toHaveLength(1);
    const { tiles, size } = seen[0]!;
    expect(size).toEqual({ width: 100, height: 101 });
    // 2 visible surfaces (snapshot tiles) + 1 separator (fill tile); hidden one omitted.
    expect(tiles).toHaveLength(3);
    expect(tiles.slice(0, 2).every((t) => 'snapshot' in t)).toBe(true);
    // separators come AFTER surfaces (painted over the top) and carry the fill color.
    const sep = tiles[2]!;
    expect('fill' in sep && sep.fill).toBe('#abcabc');
    expect(sep.rect).toEqual({ x: 0, y: 50, width: 100, height: 1 });
  });

  test('no surfaces and no separators → composeSnapshot with an empty tile list', () => {
    const { composer, seen } = recordingComposer();
    captureScreenshot(composer, [], [], '#000', { width: 10, height: 10 });
    expect(seen[0]!.tiles).toEqual([]);
  });

  test('includeCrosshair defaults to true and is forwarded to the compositor', () => {
    const { composer, seen } = recordingComposer();
    captureScreenshot(composer, [], [], '#000', { width: 10, height: 10 });
    expect(seen[0]!.includeCrosshair).toBe(true);
  });

  test('includeCrosshair=false is forwarded so the backend composes base-only (§5.2/§8.6)', () => {
    const { composer, seen } = recordingComposer();
    const surfaces = [fakeSurface({ x: 0, y: 0, width: 100, height: 50 }, true, 'pane0')];
    captureScreenshot(composer, surfaces, [], '#000', { width: 100, height: 50 }, false);
    expect(seen[0]!.includeCrosshair).toBe(false);
    // tiles are unchanged by the toggle — the omission happens in the compositor, not here.
    expect(seen[0]!.tiles).toHaveLength(1);
    expect('snapshot' in seen[0]!.tiles[0]!).toBe(true);
  });
});
