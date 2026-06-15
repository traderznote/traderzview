// Spec of record: 02-public-api-spec.md §7 (IChart) + §2 (identity law) + §16 (error
// behavior). Every assertion is hand-derived from those contracts, not echoed from the
// impl. Headless: a tiny real ChartModel (its panes/options are exact) + recording
// fakes for the host, the wiring, and the sibling handles. No DOM, no canvas, no rAF.
import { describe, expect, test, vi } from 'vitest';
import { ChartModel } from '../model';
import type { Pane, Series } from '../model';
import { ChartError } from './errors';
import { EventHub } from './events';
import type { MouseEventHandler } from './events';
import { LineSeries } from './series-defs';
import type { ISeries, SeriesType } from './series';
import type { ITimeScale } from './time-scale';
import { createChartApi } from './chart';
import type {
  ChartApiDeps,
  ChartHostFacade,
  ChartWiring,
  DisposedCell,
  IPane,
  IPriceScale,
} from './chart';

// ---------------------------------------------------------------------------------
// Test rig: a real ChartModel (so panes()/options()/structural ops are genuine) wired
// to recording fakes for the host + the chart wiring. The wiring builds ONE handle per
// underlying entity (so the chart's own cache is what enforces ===) and records calls.
// ---------------------------------------------------------------------------------

// A stub IHorzScaleBehavior — the model only stores it (never calls it at construction
// or in any path these tests exercise), so the members can be no-ops.
function stubBehavior(): never {
  return {} as never;
}

interface Rig {
  api: ReturnType<typeof createChartApi<unknown>>;
  model: ChartModel<unknown>;
  host: ChartHostFacade & { snapshots: number; disposes: number; sizes: { width: number; height: number }[] };
  wiring: RecordingWiring;
  disposed: DisposedCell;
}

interface RecordingWiring extends ChartWiring<unknown> {
  paneHandlesBuilt: number;
  priceScaleHandlesBuilt: number;
  timeScalesBuilt: number;
  seriesCreated: { paneIndex: number }[];
  destroyed: Series[];
  crosshair: { price: number | null; series: Series | null }[];
  cleared: number;
}

function makeRig(options?: Record<string, unknown>): Rig {
  const model = new ChartModel<unknown>({
    behavior: stubBehavior(),
    invalidate: () => {},
    options: options as never,
  });

  const host = {
    snapshots: 0,
    disposes: 0,
    sizes: [] as { width: number; height: number }[],
    setSize(size: { width: number; height: number }): void {
      this.sizes.push(size);
    },
    takeScreenshot(): never {
      this.snapshots++;
      return { layers: [] } as never;
    },
    input(): never {
      return { register: () => () => {} } as never;
    },
    dispose(): void {
      this.disposes++;
    },
  };

  // One model-Series per createSeries; the wiring maps handle↔model so removeSeries +
  // seriesModel resolve correctly. The pane/scale/timeScale builders count construction
  // so the test can prove the CHART cached (builder called once across repeated reads).
  const handleToModel = new Map<ISeries<SeriesType, unknown>, Series>();
  const events = {
    click: new EventHub<Parameters<MouseEventHandler<unknown>>>(),
    dblClick: new EventHub<Parameters<MouseEventHandler<unknown>>>(),
    crosshairMove: new EventHub<Parameters<MouseEventHandler<unknown>>>(),
  };

  const wiring: RecordingWiring = {
    paneHandlesBuilt: 0,
    priceScaleHandlesBuilt: 0,
    timeScalesBuilt: 0,
    seriesCreated: [],
    destroyed: [],
    crosshair: [],
    cleared: 0,
    createSeries(_def, _opts, paneIndex) {
      this.seriesCreated.push({ paneIndex });
      // Ensure the target pane exists when paneIndex === count (creation, §7).
      while (model.panes().count() <= paneIndex) model.panes().addPane();
      const mdl = {} as Series;
      const handle = { seriesType: () => 'line' } as unknown as ISeries<SeriesType, unknown>;
      handleToModel.set(handle, mdl);
      return { model: mdl, handle };
    },
    destroySeries(mdl) {
      this.destroyed.push(mdl);
    },
    createPane(pane: Pane): IPane<unknown> {
      this.paneHandlesBuilt++;
      const id = pane.id();
      return { index: () => model.panes().indexOf(pane), id: () => id } as IPane<unknown>;
    },
    createTimeScale(): ITimeScale<unknown> {
      this.timeScalesBuilt++;
      return {} as ITimeScale<unknown>;
    },
    createPriceScale(pane: Pane, scaleId: string): IPriceScale {
      this.priceScaleHandlesBuilt++;
      return { id: () => scaleId, __pane: pane.id() } as unknown as IPriceScale;
    },
    setCrosshairPosition(price, _horzItem, series) {
      this.crosshair.push({ price, series });
    },
    clearCrosshairPosition() {
      this.cleared++;
    },
    seriesModel(handle) {
      return handleToModel.get(handle) ?? null;
    },
    events,
  };

  const disposed: DisposedCell = { value: false };
  const deps: ChartApiDeps<unknown> = {
    model,
    host,
    behavior: stubBehavior(),
    wiring,
    disposed,
    element: {} as HTMLDivElement,
    barSpacing: () => 6,
  };

  return { api: createChartApi(deps), model, host, wiring, disposed };
}

// =================================================================================
// §2 — the identity law: one cached handle per underlying entity, === across calls
// =================================================================================

describe('§2 identity law', () => {
  test('panes()[i] === panes()[i] across calls (one cached pane handle)', () => {
    const { api } = makeRig(); // addDefaultPane=true → exactly one pane
    const a = api.panes();
    const b = api.panes();
    expect(a.length).toBe(1);
    // Fresh array each call (§4.3), but the SAME handle object inside (§2).
    expect(a).not.toBe(b);
    expect(a[0]).toBe(b[0]);
  });

  test('addPane returns the SAME handle that later appears in panes()', () => {
    const { api } = makeRig();
    const added = api.addPane();
    const list = api.panes();
    expect(list[list.length - 1]).toBe(added);
  });

  test('the pane handle builder runs once per pane (chart cache, not the wiring)', () => {
    const { api, wiring } = makeRig();
    api.panes();
    api.panes();
    api.panes();
    expect(wiring.paneHandlesBuilt).toBe(1); // one pane, built once, then cached
  });

  test('timeScale() is a singleton — same object every call, built once', () => {
    const { api, wiring } = makeRig();
    expect(api.timeScale()).toBe(api.timeScale());
    expect(wiring.timeScalesBuilt).toBe(1);
  });

  test('priceScale(id) is cached per (pane, scaleId) — === across calls', () => {
    const { api, wiring } = makeRig();
    const right1 = api.priceScale('right');
    const right2 = api.priceScale('right');
    expect(right1).toBe(right2);
    expect(wiring.priceScaleHandlesBuilt).toBe(1);
    // A different id on the same pane is a distinct cached handle.
    const left = api.priceScale('left');
    expect(left).not.toBe(right1);
    expect(wiring.priceScaleHandlesBuilt).toBe(2);
  });
});

// =================================================================================
// §16.5 — the disposed guard: after dispose() every method throws ChartError('disposed')
// =================================================================================

describe('§16.5 disposed guard', () => {
  test('dispose() is idempotent and tears the host down exactly once', () => {
    const { api, host } = makeRig();
    api.dispose();
    api.dispose();
    expect(host.disposes).toBe(1);
  });

  test('every method throws ChartError("disposed") after dispose()', () => {
    const { api } = makeRig();
    const fakeSeries = { seriesType: () => 'line' } as unknown as ISeries<SeriesType, unknown>;
    api.dispose();

    const calls: Array<() => unknown> = [
      () => api.resize(10, 10),
      () => api.autoSizeActive(),
      () => api.element(),
      () => api.addSeries(LineSeries),
      () => api.removeSeries(fakeSeries),
      () => api.panes(),
      () => api.addPane(),
      () => api.removePane(0),
      () => api.swapPanes(0, 0),
      () => api.timeScale(),
      () => api.priceScale('right'),
      () => api.applyOptions({}),
      () => api.options(),
      () => api.setCrosshairPosition(1, 0),
      () => api.clearCrosshairPosition(),
      () => api.horzBehavior(),
      () => api.input(),
      () => api.takeScreenshot(),
      () => api.subscribeClick(() => {}),
      () => api.unsubscribeClick(() => {}),
      () => api.subscribeDblClick(() => {}),
      () => api.unsubscribeDblClick(() => {}),
      () => api.subscribeCrosshairMove(() => {}),
      () => api.unsubscribeCrosshairMove(() => {}),
    ];
    for (const call of calls) {
      expect(call).toThrowError(ChartError);
      try {
        call();
      } catch (e) {
        expect((e as ChartError).code).toBe('disposed');
      }
    }
  });

  test('the disposed cell is shared (chart-wide) — flips for the sibling ports too', () => {
    const { api, disposed } = makeRig();
    expect(disposed.value).toBe(false);
    api.dispose();
    expect(disposed.value).toBe(true); // sibling facades (series ports) read this object
  });
});

// =================================================================================
// §7 — lifecycle & accessor behavioral contracts
// =================================================================================

describe('§7 lifecycle', () => {
  test('resize forwards the explicit size to the host when autoSize is off', () => {
    const { api, host } = makeRig();
    api.resize(640, 480);
    expect(host.sizes).toEqual([{ width: 640, height: 480 }]);
  });

  test('resize is a no-op + warn while autoSize is active (§7 / §16.4)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { api, host } = makeRig({ autoSize: true });
    api.resize(640, 480);
    expect(host.sizes).toEqual([]); // no host call
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test('autoSizeActive() reflects the configured option', () => {
    expect(makeRig().api.autoSizeActive()).toBe(false);
    expect(makeRig({ autoSize: true }).api.autoSizeActive()).toBe(true);
  });

  test('element() returns the generated container div', () => {
    const { api } = makeRig();
    expect(api.element()).toBeDefined();
  });

  test('takeScreenshot delegates to the host (which flushes first, §7)', () => {
    const { api, host } = makeRig();
    api.takeScreenshot();
    api.takeScreenshot({ includeCrosshair: true });
    expect(host.snapshots).toBe(2);
  });
});

// =================================================================================
// §7 / §8 — addSeries / removeSeries
// =================================================================================

describe('§7 series', () => {
  test('addSeries defaults paneIndex to 0 (§7)', () => {
    const { api, wiring } = makeRig();
    api.addSeries(LineSeries);
    expect(wiring.seriesCreated).toEqual([{ paneIndex: 0 }]);
  });

  test('addSeries with paneIndex === paneCount targets the new pane (§7)', () => {
    const { api, wiring } = makeRig(); // one default pane (count 1)
    api.addSeries(LineSeries, undefined, 1); // === count → create the pane
    expect(wiring.seriesCreated).toEqual([{ paneIndex: 1 }]);
  });

  test('addSeries with paneIndex > paneCount throws RangeError (§16.2)', () => {
    const { api } = makeRig(); // count 1 → 2 is out of range (only 0 or 1 allowed)
    expect(() => api.addSeries(LineSeries, undefined, 2)).toThrowError(RangeError);
  });

  test('addSeries on a foreign object throws ChartError("unknown-series-definition") (§16.3)', () => {
    const { api } = makeRig();
    const foreign = { type: 'line' } as never; // no createKind → not a definition pair
    expect(() => api.addSeries(foreign)).toThrowError(ChartError);
    try {
      api.addSeries(foreign);
    } catch (e) {
      expect((e as ChartError).code).toBe('unknown-series-definition');
    }
  });

  test('removeSeries destroys the backing model series; a foreign handle is a no-op', () => {
    const { api, wiring } = makeRig();
    const handle = api.addSeries(LineSeries);
    api.removeSeries(handle);
    expect(wiring.destroyed.length).toBe(1);
    // A handle the chart never minted resolves to no model → no destroy call.
    api.removeSeries({ seriesType: () => 'line' } as unknown as ISeries<SeriesType, unknown>);
    expect(wiring.destroyed.length).toBe(1);
  });
});

// =================================================================================
// §7 / §11 — panes
// =================================================================================

describe('§7 panes', () => {
  test('removePane with a single pane is a no-op (§7 / §16.4)', () => {
    const { api, model } = makeRig(); // one pane
    api.removePane(0);
    expect(model.panes().count()).toBe(1);
  });

  test('removePane drops the pane when more than one exists', () => {
    const { api, model } = makeRig();
    api.addPane(); // now two panes
    expect(model.panes().count()).toBe(2);
    api.removePane(1);
    expect(model.panes().count()).toBe(1);
  });

  test('removePane out of range throws RangeError (§16.2)', () => {
    const { api } = makeRig();
    expect(() => api.removePane(5)).toThrowError(RangeError);
    expect(() => api.removePane(-1)).toThrowError(RangeError);
  });

  test('swapPanes out of range throws RangeError (§16.2)', () => {
    const { api } = makeRig();
    api.addPane();
    expect(() => api.swapPanes(0, 9)).toThrowError(RangeError);
  });
});

// =================================================================================
// §10 — priceScale immediate resolution
// =================================================================================

describe('§10 priceScale resolution', () => {
  test('left/right always resolve on a live pane regardless of visibility', () => {
    const { api } = makeRig();
    expect(api.priceScale('right').id()).toBe('right');
    expect(api.priceScale('left').id()).toBe('left'); // left visible:false, still resolves
  });

  test('an absent scale id throws ChartError("no-such-scale") at the call (§10)', () => {
    const { api } = makeRig();
    expect(() => api.priceScale('volume')).toThrowError(ChartError);
    try {
      api.priceScale('volume');
    } catch (e) {
      expect((e as ChartError).code).toBe('no-such-scale');
    }
  });

  test('priceScale with an out-of-range paneIndex throws RangeError (§16.2)', () => {
    const { api } = makeRig();
    expect(() => api.priceScale('right', 7)).toThrowError(RangeError);
  });
});

// =================================================================================
// §7 — options, crosshair sync, extension seams, events
// =================================================================================

describe('§7 options & seams', () => {
  test('options() returns the model snapshot; applyOptions forwards a merge', () => {
    const { api } = makeRig();
    expect(api.options().defaultPriceScaleId).toBe('right');
    api.applyOptions({ hoveredSeriesOnTop: false });
    expect(api.options().hoveredSeriesOnTop).toBe(false);
  });

  test('options() is a fresh snapshot — mutating it never touches stored state (§4.3)', () => {
    const { api } = makeRig();
    const snap = api.options() as { layout: { textColor: string } };
    expect(() => {
      snap.layout.textColor = 'hacked'; // frozen in dev (__DEV__ under test)
    }).toThrow();
    expect(api.options().layout.textColor).toBe('#191919');
  });

  test('horzBehavior() / input() return the injected seams', () => {
    const { api } = makeRig();
    expect(api.horzBehavior()).toBeDefined();
    expect(typeof api.input().register).toBe('function');
  });

  test('setCrosshairPosition (full form) forwards the resolved model series', () => {
    const { api, wiring } = makeRig();
    const handle = api.addSeries(LineSeries);
    api.setCrosshairPosition(42, 0, handle);
    expect(wiring.crosshair.length).toBe(1);
    expect(wiring.crosshair[0]!.price).toBe(42);
    expect(wiring.crosshair[0]!.series).not.toBeNull(); // resolved through seriesModel
  });

  test('setCrosshairPosition (time-line-only, price=null) forwards with no series', () => {
    const { api, wiring } = makeRig();
    api.setCrosshairPosition(null, 0);
    expect(wiring.crosshair[0]).toEqual({ price: null, series: null });
  });

  test('clearCrosshairPosition forwards to the wiring', () => {
    const { api, wiring } = makeRig();
    api.clearCrosshairPosition();
    expect(wiring.cleared).toBe(1);
  });
});

describe('§14 chart events', () => {
  test('subscribeClick returns an Unsubscribe and the hub fires the payload', () => {
    const { api, wiring } = makeRig();
    const seen: number[] = [];
    const off = api.subscribeClick(() => seen.push(1));
    wiring.events.click.emit(() => [{ seriesData: new Map() }]);
    expect(seen).toEqual([1]);
    off();
    wiring.events.click.emit(() => [{ seriesData: new Map() }]);
    expect(seen).toEqual([1]); // unsubscribed
  });

  test('unsubscribeClick(handler) removes by reference (reference parity §14.1)', () => {
    const { api, wiring } = makeRig();
    const seen: number[] = [];
    const h: MouseEventHandler<unknown> = () => seen.push(1);
    api.subscribeClick(h);
    api.unsubscribeClick(h);
    wiring.events.click.emit(() => [{ seriesData: new Map() }]);
    expect(seen).toEqual([]);
  });

  test('dispose() tears down the chart event hubs (subscribe-after-dispose throws)', () => {
    const { api, wiring } = makeRig();
    api.subscribeCrosshairMove(() => {});
    api.dispose();
    // After dispose the guard throws before reaching the hub.
    expect(() => api.subscribeCrosshairMove(() => {})).toThrowError(ChartError);
    // And the hub itself was disposed — no listeners remain.
    expect(wiring.events.crosshairMove.hasListeners()).toBe(false);
  });
});
