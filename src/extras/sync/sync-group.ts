// traderzview · extras/sync — multi-chart SyncGroup (design 05 §6.1; the L1-L6 in-tree
// proof). createSyncGroup(charts, opts) wires N independent IChart handles into a group
// whose visible RANGES and CROSSHAIRS track one another, built ENTIRELY on three loss-
// free PUBLIC api seams + a shared scheduler (design 01 §9.3; arch §3.1 — never model/
// views/host):
//   • RANGE  — subscribeVisibleLogicalRangeChange (doc 02 §9) → on each OTHER chart
//     setVisibleLogicalRange ('logical' mode, raw) OR endpoint-map through the T5 pair
//     logicalToKey(source) → keyToLogical(target, {extrapolate:true}) ('time' mode, for
//     charts holding different datasets). Targets with EMPTY timelines are skipped (no
//     key to map) — exactly as in the per-endpoint mapping.
//   • CROSSHAIR — subscribeCrosshairMove (doc 02 §7/§14.2) → the source crosshair logical
//     (params.logical) maps to a HorzKey via logicalToKey; on each target
//     setCrosshairPosition(null, key) ('time' mode, the A-1 time-line-only form) OR, in
//     'time-price' mode, the SOURCE price derived from source.panes()[0].series()[0].
//     coordinateToPrice(params.point.y) placed on target.panes()[0].series()[0]. The
//     no-pane-0-series target falls back to the time-line-only form — SELECTED HERE, not
//     by the setter (the numeric-price form silently no-ops on a missing series, doc 02
//     §16.4); a leave/programmatic move (no params.point) or an off-scale coordinateToPrice
//     also falls back to 'time'.
// Echo suppression is a CORE guarantee, not a SyncGroup hack (L3): the public setters
// fire their change events only on an ACTUAL value change, so a programmatic set that
// lands on the current value stays silent — an A→B→A ping-pong therefore converges in
// ONE hop (B's set back onto A is a value no-op). No `source` field on any payload is
// needed (design 02 §9/§14 stand). The shared injected IFrameScheduler (L2, passed to
// each createChartWith) coalesces a pan on A and the synced pans on B/C/D into one tick.
//
// Built on api/core ONLY (arch §3.1; dep-cruiser E1). SyncGroupOptions is type-only.
import type { Disposable, Unsubscribe } from '../../core';
import type { IChart, ITimeScale, MouseEventParams } from '../../api';

// --- the design 05 §6.1 options (owned here; the value export is createSyncGroup) -----

/** How a SyncGroup mirrors charts (design 05 §6.1). Both axes opt out with `'off'`. */
export interface SyncGroupOptions {
  /** `'logical'` mirrors raw logical ranges (same-density datasets — one symbol, several
   *  panes of the same timeframe). `'time'` maps range endpoints through HorzKey
   *  (logicalToKey on the source, keyToLogical(.., { extrapolate: true }) on each target —
   *  the same T5 pair the tools use) for charts holding DIFFERENT datasets. `'off'`
   *  disables range sync. Default: `'logical'`. */
  range?: 'off' | 'logical' | 'time';
  /** `'time'` moves only the vertical time line on targets (the price:null A-1 form).
   *  `'time-price'` also forwards the price: the SOURCE price is read from the source's
   *  first pane-0 series via coordinateToPrice(params.point.y) (the payload carries no
   *  price field — doc 02 §14.2) and placed on each TARGET's first pane-0 series
   *  (panes()[0].series()[0]); a target with no pane-0 series, a leave/programmatic move
   *  (no point), or an off-scale price falls back to the time-line-only form. `'off'`
   *  disables crosshair sync. Default: `'time'`. */
  crosshair?: 'off' | 'time' | 'time-price';
}

// --- a tiny price-bearing view of the public series handle ---------------------------
// The public ISeries handle is H-generic + heavyweight; SyncGroup needs ONLY the two
// price↔coordinate seams (doc 02 §8.2). Narrowing here keeps the group's reach to the
// exact public surface it consumes (and lets a headless test hand a minimal stub).

/** The slice of the pane-0 first series SyncGroup reads/writes prices through (§8.2). */
interface PriceSeries {
  coordinateToPrice(coordinate: number): number | null;
}

/** A target chart, narrowed to the public methods SyncGroup drives. `H` is the chart's
 *  horizontal item; crosshair/range set by HorzKey (a plain number), so H stays opaque. */
type SyncChart<H> = IChart<H>;

// --- the group -----------------------------------------------------------------------

/**
 * Build a SyncGroup over `charts` (design 05 §6.1 — value export createSyncGroup, A-6).
 * Returns a Disposable that, on dispose(), drops EVERY subscription (idempotent; no
 * dangling handler writes after teardown). The group itself owns no per-frame state —
 * each event re-reads the live public range/crosshair and forwards it; echo suppression
 * (L3) keeps the fan-out from looping. `charts` of length < 2 wires nothing meaningful
 * (the subscriptions still register, but a single chart never forwards to a peer).
 */
export function createSyncGroup<H = unknown>(
  charts: readonly IChart<H>[],
  opts?: SyncGroupOptions,
): Disposable {
  const rangeMode = opts?.range ?? 'logical';
  const crosshairMode = opts?.crosshair ?? 'time';

  const offs: Unsubscribe[] = [];
  // Re-entrancy guard: a programmatic setter SHOULD be a value no-op (L3) and fire
  // nothing, but a fake/edge backend that re-fires would otherwise recurse. The flag
  // makes the one-hop convergence robust headlessly without depending on a source field.
  // PER-CHANNEL (not one shared flag): a crosshair event that lands MID range fan-out (or
  // a range event mid crosshair fan-out) is an independent signal and must NOT be swallowed
  // — only an echo on the SAME channel (range→range, crosshair→crosshair) is suppressed.
  let forwardingRange = false;
  let forwardingCrosshair = false;

  const ts = (c: SyncChart<H>): ITimeScale<H> => c.timeScale();

  // The first series on the first pane, narrowed to its price seam — or null when the
  // chart has no pane-0 series (the §6.1 no-series fallback condition). Read live each
  // time (panes/series can change between events).
  const firstPaneSeries = (c: SyncChart<H>): PriceSeries | null => {
    const panes = c.panes();
    if (panes.length === 0) return null;
    const series = (panes[0] as unknown as { series(): readonly unknown[] }).series();
    return series.length > 0 ? (series[0] as unknown as PriceSeries) : null;
  };
  // The pane-0 first series as the full public ISeries handle (the setCrosshairPosition
  // `series` argument) — same slot as firstPaneSeries, untyped for the setter call.
  const firstSeriesHandle = (c: SyncChart<H>): unknown => {
    const panes = c.panes();
    if (panes.length === 0) return null;
    const series = (panes[0] as unknown as { series(): readonly unknown[] }).series();
    return series.length > 0 ? series[0] : null;
  };

  // === RANGE sync (design 05 §6.1) ====================================================
  if (rangeMode !== 'off') {
    for (const source of charts) {
      const off = ts(source).subscribeVisibleLogicalRangeChange((range) => {
        if (forwardingRange || range === null) return; // null = source scale went empty
        forwardingRange = true;
        try {
          forwardRange(source, range);
        } finally {
          forwardingRange = false;
        }
      });
      offs.push(off);
    }
  }

  // Push the source's new logical range onto every OTHER chart. In 'logical' mode the
  // raw range is mirrored verbatim (same-density datasets). In 'time' mode each endpoint
  // is mapped to a HorzKey on the source (logicalToKey) then back to each TARGET's own
  // logical via keyToLogical(.., { extrapolate: true }) — the T5 pair — so charts holding
  // DIFFERENT datasets stay time-aligned. Targets with empty timelines are skipped (no
  // key↔logical mapping exists there).
  function forwardRange(source: SyncChart<H>, range: { from: number; to: number }): void {
    if (rangeMode === 'logical') {
      for (const target of charts) {
        if (target === source) continue;
        ts(target).setVisibleLogicalRange({ from: range.from, to: range.to });
      }
      return;
    }
    // 'time': map source-logical → key once, then key → each target-logical.
    const srcTs = ts(source);
    const fromKey = srcTs.logicalToKey(range.from, { extrapolate: true });
    const toKey = srcTs.logicalToKey(range.to, { extrapolate: true });
    if (fromKey === null || toKey === null) return; // source scale empty → nothing to map
    for (const target of charts) {
      if (target === source) continue;
      const tgtTs = ts(target);
      const from = tgtTs.keyToLogical(fromKey as number, { extrapolate: true });
      const to = tgtTs.keyToLogical(toKey as number, { extrapolate: true });
      if (from === null || to === null) continue; // empty target timeline → skip (§6.1)
      tgtTs.setVisibleLogicalRange({ from: from as number, to: to as number });
    }
  }

  // === CROSSHAIR sync (design 05 §6.1) ================================================
  if (crosshairMode !== 'off') {
    for (const source of charts) {
      const off = source.subscribeCrosshairMove((params) => {
        if (forwardingCrosshair) return;
        forwardingCrosshair = true;
        try {
          forwardCrosshair(source, params);
        } finally {
          forwardingCrosshair = false;
        }
      });
      offs.push(off);
    }
  }

  // Forward the source crosshair to every OTHER chart. The source crosshair logical
  // (params.logical, doc 02 §14.2) maps to a HorzKey via the source's logicalToKey; a
  // leave/programmatic move with no logical maps to no key → clears nothing here (the
  // group only PLACES lines). In 'time-price' the source price is derived from the
  // source's pane-0 first series (coordinateToPrice on the pixel y) when a point exists;
  // each target gets the numeric form on ITS pane-0 first series, falling back to the
  // time-line-only (price:null) form when the target has no such series.
  function forwardCrosshair(source: SyncChart<H>, params: MouseEventParams<H>): void {
    if (params.logical === undefined) return; // off-scale / no crosshair slot → nothing
    const key = ts(source).logicalToKey(params.logical as unknown as number, { extrapolate: true });
    if (key === null) return; // source scale empty → no key to forward
    const horz = key as unknown as H;

    // Derive the source price for 'time-price' (skipped → null = time-line-only). The
    // payload carries no price (doc 02 §14.2): read it from the source's pane-0 first
    // series via coordinateToPrice(point.y). Absent point (leave/programmatic), no pane-0
    // series, or an off-scale (null) price all fall back to the time-line-only form.
    let price: number | null = null;
    if (crosshairMode === 'time-price' && params.point !== undefined) {
      const srcSeries = firstPaneSeries(source);
      if (srcSeries !== null) {
        const p = srcSeries.coordinateToPrice(params.point.y as unknown as number);
        if (p !== null) price = p;
      }
    }

    for (const target of charts) {
      if (target === source) continue;
      if (price === null) {
        // time-line-only form (A-1): vertical line + time label, no price line. Used by
        // crosshair: 'time', and as the §6.1 fallback whenever no price was derived.
        target.setCrosshairPosition(null, horz);
        continue;
      }
      // 'time-price' with a derived price: place it on the target's pane-0 first series.
      // A series-less target gets the time-line-only form instead — the SyncGroup selects
      // it (the numeric form silently no-ops on a missing series, doc 02 §16.4).
      const tgtSeries = firstSeriesHandle(target);
      if (tgtSeries === null) {
        target.setCrosshairPosition(null, horz);
      } else {
        target.setCrosshairPosition(price, horz, tgtSeries as never);
      }
    }
  }

  // --- teardown: drop every subscription (idempotent; no post-dispose handler runs) ---
  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      offs.length = 0;
    },
  };
}
