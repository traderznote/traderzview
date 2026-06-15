// traderzview · host/screenshot — the single-pass screenshot collector (§7). After
// a synchronous frame flush the host already knows every rect (computeLayout); this
// walks the surface tree ONCE, emitting one snapshot tile per visible surface plus
// one solid `fill` tile per 1-px pane separator (separators are surface-less DOM
// divs — without a fill tile they would be holes in the screenshot, study 01 §3.7).
// Compositing is a backend op: the host knows rects + colors, never a pixel (§5.2).
import type { Rect, Size } from '../core';
import type { Snapshot, SnapshotTile } from '../gfx';
import type { SurfaceHost } from './surface-host';

/** The backend's screenshot compositor (the injected IRenderBackend, narrowed). The
 *  `includeCrosshair` arg is optional so the bare IRenderBackend method
 *  `composeSnapshot(tiles, mediaSize)` is structurally assignable here; the canvas
 *  backend reads it to toggle the overlay (crosshair) layer in the composite (§8.6). */
export interface SnapshotComposer {
  composeSnapshot(tiles: readonly SnapshotTile[], mediaSize: Size, includeCrosshair?: boolean): Snapshot;
}

/**
 * Collect tiles in paint order — surfaces first (snapshot tiles), then separators
 * (fill tiles over the top) — and compose them at `mediaSize`. An invisible (0-area)
 * surface contributes no tile (its snapshot would be 0×0 and `composeSnapshot` skips
 * it anyway, §5.1.5). `includeCrosshair` (default true) is forwarded to the compositor:
 * when false, the backend composes the base layer only and the crosshair/cursor/overlay
 * bands are omitted from the screenshot (§5.2/§8.6). Returns the opaque public `Snapshot`.
 */
export function captureScreenshot(
  composer: SnapshotComposer,
  surfaces: readonly SurfaceHost[],
  separators: readonly Rect[],
  separatorColor: string,
  mediaSize: Size,
  includeCrosshair = true,
): Snapshot {
  const tiles: SnapshotTile[] = [];
  for (let i = 0; i < surfaces.length; i++) {
    const sh = surfaces[i]!;
    if (sh.visible()) tiles.push({ rect: sh.rect(), snapshot: sh.snapshot() });
  }
  for (let i = 0; i < separators.length; i++) {
    tiles.push({ rect: separators[i]!, fill: separatorColor });
  }
  return composer.composeSnapshot(tiles, mediaSize, includeCrosshair);
}
