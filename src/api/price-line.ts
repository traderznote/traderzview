// traderzview · api — the IPriceLine facade (spec 02 §11.1). A THIN wrapper over the
// M7 price-line scene source via an injected port; owns NO business logic. Identity
// (§2): the series caches one handle per createPriceLine call; series.removePriceLine
// KILLS it (port.isAlive() → false, then every method throws). Disposed-guard (§16.5):
// after chart.dispose() every method throws disposed FIRST. The price-line option group
// has no §5.3 normalizations, so applyOptions forwards unchanged (the model owns the
// merge + the §4.3 snapshot). NEVER imports backend-canvas (§3.1). `IPriceLine`/
// `PriceLineOptions` are owned by ./series (§11.1 surface); this file owns the factory.
import type { DeepPartial, DeepReadonly } from '../core';
import { ChartErrorCode, throwChartError } from './errors';
import type { IPriceLine, PriceLineOptions } from './series';

/**
 * The series-owned port the facade delegates to. Create-chart wires it over the M7
 * price-line source (through the owning series): the model/views own the merge, the
 * reset target, and the snapshot; the facade adds only the §11.1/§16 boundary guards.
 */
export interface PriceLinePort {
  /** The chart's shared disposed flag (§16.5) — true once chart.dispose() ran. */
  isDisposed(): boolean;
  /** True while attached; false once series.removePriceLine ran — then methods throw
   *  (§11.1: a removed line's handle is permanently dead). */
  isAlive(): boolean;
  /** Merge a patch over the stored options (the model owns the §5.1 merge). */
  applyOptions(patch: DeepPartial<PriceLineOptions>): void;
  /** A fresh, immutable snapshot of the stored options (§4.3 — never the live object). */
  options(): DeepReadonly<PriceLineOptions>;
}

export interface PriceLineApiDeps {
  readonly port: PriceLinePort;
}

/**
 * Build the cached IPriceLine facade for one created line (§11.1). The wiring calls this
 * once per createPriceLine and caches the result on the series (§2); after
 * series.removePriceLine the port reports `!isAlive()` and the handle is permanently
 * dead. Guard order: a disposed chart wins chart-wide (§16.5), then a removed line throws
 * too — both at the facade boundary, never deep internals (§17 A15). No per-line error
 * code exists (§16); a dead handle IS disposed from the caller's view, so it reuses that.
 */
export function createPriceLineApi(deps: PriceLineApiDeps): IPriceLine {
  const { port } = deps;
  const guard = (): void => {
    if (port.isDisposed() || !port.isAlive()) throwChartError(ChartErrorCode.Disposed);
  };

  const api: IPriceLine = {
    applyOptions(patch): void {
      guard();
      port.applyOptions(patch);
    },
    options(): DeepReadonly<PriceLineOptions> {
      guard();
      return port.options();
    },
  };

  return api;
}
