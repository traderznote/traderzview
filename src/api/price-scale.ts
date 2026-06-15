// traderzview · api — the IPriceScale facade (spec 02 §10). A THIN wrapper over the
// model PriceScale (navigator + autoscale + geometry); owns NO business logic the model
// has. Identity (§2): the CHART caches one handle per (pane, scaleId) — a destroyed
// overlay scale's handle stays DEAD permanently (every method then throws no-such-scale,
// via port.isAlive()); a re-created id yields a FRESH cached handle. Disposed-guard
// (§16.5): after chart.dispose() every method throws disposed FIRST. Boundary rules the
// facade owns: from > to throws RangeError FIRST regardless of data, then a no-data scale
// silently no-ops setVisibleRange (mirrors §9); setVisibleRange disables autoscale first;
// setAutoScale is sugar over applyOptions({ autoScale }). NEVER imports backend-canvas.
import type { BarPrice, DeepPartial, DeepReadonly } from '../core';
import type { PriceScaleOptions } from '../model';
import { ChartErrorCode, throwChartError } from './errors';

// --- the public IPriceScale interface (§10) ----------------------------------------

/**
 * The price-scale handle (§10). Cached per (pane, scaleId) by the chart (§2). Every
 * method throws after dispose() (§16.5) and after the underlying scale is destroyed
 * (last overlay series left / pane removed → no-such-scale).
 */
export interface IPriceScale {
  id(): string;
  applyOptions(patch: DeepPartial<PriceScaleOptions>): void;
  options(): DeepReadonly<PriceScaleOptions>;
  /** 0 for overlay scales (kept §10). */
  width(): number;
  /** log-mode de-noise rounding kept (study 09 §4.8); null when the scale has no data. */
  getVisibleRange(): { from: BarPrice; to: BarPrice } | null;
  /** Disables autoscale first (kept §10). from > to throws RangeError; no-data no-op. */
  setVisibleRange(range: { from: number; to: number }): void;
  /** Sugar for applyOptions({ autoScale }) (kept §10). */
  setAutoScale(on: boolean): void;
  /** Live state (§5.5) — true unless disabled by option or manual interaction. */
  autoScaleActive(): boolean;
}

// --- the chart-owned port (injected by create-chart.ts) ----------------------------

/**
 * Everything the facade delegates to. Create-chart wires it over the model PriceScale so
 * the facade stays a pure map-through; the port owns the autoscale-disable + log de-noise
 * math the model implements. The facade adds only the §10 boundary rules (the two guards,
 * from > to RangeError, the no-data no-op).
 */
export interface PriceScalePort {
  /** The chart's shared disposed flag (§16.5) — true once chart.dispose() ran. */
  isDisposed(): boolean;
  /** True while the underlying scale still exists; false once destroyed — then every
   *  method throws no-such-scale (§10: a destroyed scale's handle stays dead). */
  isAlive(): boolean;
  /** True when the scale has no data: setVisibleRange is a silent no-op (§10, mirrors §9). */
  isEmpty(): boolean;

  id(): string;
  applyOptions(patch: DeepPartial<PriceScaleOptions>): void;
  /** A fresh snapshot of the configured options (§4.3, NOT live state §5.5). */
  options(): DeepReadonly<PriceScaleOptions>;
  /** 0 for overlay scales (the model returns it). */
  width(): number;
  /** log-mode de-noise rounding lives in the model (study 09 §4.8); null on no data. */
  getVisibleRange(): { from: BarPrice; to: BarPrice } | null;
  /** The model disables autoscale then applies the manual range (kept §10). */
  setVisibleRange(range: { from: number; to: number }): void;
  /** Live autoscale state (§5.5) — true unless disabled by option or interaction. */
  autoScaleActive(): boolean;
}

export interface PriceScaleApiDeps {
  readonly port: PriceScalePort;
}

// --- the facade factory ------------------------------------------------------------

/**
 * Build the cached IPriceScale facade for one (pane, scaleId) (§10). The chart calls
 * this once per (pane, scaleId) and caches the result (§2); a re-created overlay id mints
 * a fresh handle through the chart's per-pane Map. Guard order: disposed wins chart-wide
 * (§16.5), then a destroyed scale's handle is permanently dead (§10) — both facade-
 * boundary throws, never deep internals.
 */
export function createPriceScaleApi(deps: PriceScaleApiDeps): IPriceScale {
  const { port } = deps;
  const guard = (): void => {
    if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
    if (!port.isAlive()) throwChartError(ChartErrorCode.NoSuchScale, port.id());
  };

  const api: IPriceScale = {
    id(): string {
      // id() survives destruction (the dead handle still knows which id it WAS); only a
      // disposed chart silences it (§16.5).
      if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
      return port.id();
    },

    applyOptions(patch): void {
      guard();
      // The price-scale group carries none of the §5.3 normalizations; the MODEL owns the
      // merge against its effective-defaults reset target (§5.1). Forward unchanged.
      port.applyOptions(patch);
    },
    options(): DeepReadonly<PriceScaleOptions> {
      guard();
      return port.options();
    },
    width(): number {
      guard();
      return port.width();
    },
    getVisibleRange(): { from: BarPrice; to: BarPrice } | null {
      guard();
      return port.getVisibleRange();
    },
    setVisibleRange(range): void {
      guard();
      // from > to is malformed input — RangeError FIRST, even with no data (§10/§16.2).
      // Then a no-data scale silently no-ops (mirrors §9 / §16.4). Otherwise the port
      // disables autoscale and applies the manual range (kept §10).
      if (range.from > range.to) {
        throw new RangeError('setVisibleRange: from must be <= to');
      }
      if (port.isEmpty()) return;
      port.setVisibleRange(range);
    },
    setAutoScale(on): void {
      guard();
      // Sugar for applyOptions({ autoScale }) (kept §10) — one source of truth, the
      // model's merge + invalidation; no separate autoscale code path.
      port.applyOptions({ autoScale: on });
    },
    autoScaleActive(): boolean {
      guard();
      return port.autoScaleActive();
    },
  };

  return api;
}
