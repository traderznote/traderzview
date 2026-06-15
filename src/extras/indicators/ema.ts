// traderzview · extras/indicators — EMA computed series (design 05 §5; the I1-I6
// in-tree proof). An indicator READS its INPUT through the zero-copy, identity-stable
// `ISeries.store()` view (I2) and PUSHES results to a SEPARATE output series via that
// output's OWN public `setData`/`update` (I3) — the single-ingress rule. NO
// PlotStoreWriter, NO derived-store, NO 'feed-conflict' symbol; an indicator output IS
// an ordinary series on the shared union timeline (design 01 §9.2 item 2's deliberate
// cut). Recompute is driven by the input's `subscribeDataChanged` typed diff (I1):
// `append` pushes the new tail via `update`, `replace`/`insert`/`reindex` rebuild via
// `setData`. The push runs INSIDE the input's synchronous data-changed callback, so the
// input + output invalidations coalesce into ONE frame (I6). Panes are first-class (I5):
// `pane: 'own'` opens the indicator's own oscillator pane. Built ONLY on the PUBLIC api
// seams (IChart/ISeries/PlotStoreView/StoreDiff/SeriesDefinition + LineSeries) + core
// (mergeOptions/DeepPartial/Disposable) — never model/views (arch §3.1; dep-cruiser E1).
import { mergeOptions } from '../../core';
import type { DeepPartial, Disposable, Unsubscribe } from '../../core';
import { LineSeries } from '../../api';
import type {
  IChart,
  ISeries,
  PlotStoreView,
  SeriesDefinition,
  SeriesType,
  StoreDiff,
  Time,
} from '../../api';

// --- the design 05 §5.1 indicator shapes (owned here; consumed by the host below) ---

/** One output series an indicator produces. `pane: 'input'` overlays it on the input's
 *  pane (default — EMA is an overlay); `'own'` opens a fresh oscillator pane (I5). */
export interface IndicatorOutput {
  readonly id: string;
  readonly definition: SeriesDefinition<SeriesType, unknown, unknown>;
  readonly pane: 'input' | 'own';
}

/** How the host applies a patch's `rows` to its output series (design 05 §5.1). */
export type IndicatorPatchMode = 'append' | 'updateLast' | 'replace';

/** A single output-series patch the computer returns. `fromRow` is the first INPUT row
 *  index `rows` aligns to; the host pairs each value with the TIME of input row
 *  `fromRow + k` (the host owns both series + the timeline) and applies it through the
 *  output series' own `setData`/`update` — the computer never handles `H`/`HorzKey`. */
export interface IndicatorOutputPatch {
  readonly outputId: string;
  readonly mode: IndicatorPatchMode;
  readonly fromRow: number;
  /** One value per input row from `fromRow`; `null` = a whitespace/gap output row. */
  readonly rows: readonly (number | null)[];
}

/** The incremental computer (design 05 §5.1). Works purely in input-row-index/value
 *  space — reads the rows it needs through the zero-copy view, emits per-output values. */
export interface IndicatorComputer {
  /** Per-output lookback bounding an incremental `updateLast` recompute (EMA = 1). */
  readonly warmup: number;
  apply(diff: StoreDiff, input: PlotStoreView): readonly IndicatorOutputPatch[];
}

/** An indicator definition (design 05 §5.1): outputs + a computer factory. */
export interface IndicatorDefinition<P> {
  readonly type: string;
  readonly defaultParams: P;
  readonly outputs: readonly IndicatorOutput[];
  createComputer(params: P): IndicatorComputer;
}

// --- EMA params + definition -------------------------------------------------------

/** EMA parameters. `period` is the span N (α = 2/(N+1)). */
export interface EmaParams {
  period: number;
}

export const defaultEmaParams: EmaParams = { period: 9 };

const EMA_OUTPUT_ID = 'ema';

/**
 * EMA over a single value lane (the input's `current` role — close for OHLC, value for
 * single-value). A streaming recurrence with running state so an `append`/`updateLast`
 * tail recompute is O(count): `e[i] = α·x[i] + (1−α)·e[i−1]`, seeded `e[0] = x[0]`.
 */
function createEmaComputer(params: EmaParams): IndicatorComputer {
  if (!Number.isFinite(params.period) || params.period < 1) {
    throw new RangeError(`ema: period must be a finite number >= 1, got ${params.period}`);
  }
  const alpha = 2 / (params.period + 1);
  // Running state carried across incremental diffs. `emaAt` is the EMA value at row
  // index `emaRow`; `emaBefore` is the EMA at `emaRow − 1` (so `updateLast` can rewind
  // exactly one row — warmup 1 — and recompute the last row from its true predecessor).
  // A `replace`/`insert`/`reindex` resets all three (full rebuild).
  let emaAt = Number.NaN;
  let emaBefore = Number.NaN;
  let emaRow = -1;

  /** Compute the EMA for input rows [from, store.length), seeding the recurrence from
   *  `seed` (the EMA at `from − 1`, or NaN to seed at the first finite x). Advances the
   *  running state to the last computed row. */
  const run = (input: PlotStoreView, from: number, seed: number): (number | null)[] => {
    const out: (number | null)[] = [];
    let e = seed;
    let before = seed; // EMA at (current row − 1) as the loop advances
    for (let i = from; i < input.length; i++) {
      const x = input.current(i);
      if (!Number.isFinite(x)) {
        out.push(null); // whitespace/gap input row → whitespace output row
        continue;
      }
      before = e;
      e = Number.isFinite(e) ? alpha * x + (1 - alpha) * e : x; // seed at first finite x
      out.push(e);
    }
    emaAt = e;
    emaBefore = before;
    emaRow = input.length - 1;
    return out;
  };

  const reset = (): void => {
    emaAt = Number.NaN;
    emaBefore = Number.NaN;
    emaRow = -1;
  };

  return {
    warmup: 1,
    apply(diff: StoreDiff, input: PlotStoreView): readonly IndicatorOutputPatch[] {
      if (input.length === 0) {
        reset();
        return [{ outputId: EMA_OUTPUT_ID, mode: 'replace', fromRow: 0, rows: [] }];
      }
      switch (diff.kind) {
        case 'append': {
          // The new tail starts where the previous compute ended (count is informational;
          // recomputing from the first uncomputed row makes a coalesced multi-append safe).
          // Seed from the EMA at the boundary row (emaAt = e[emaRow]).
          const from = Math.max(0, emaRow + 1);
          return [{ outputId: EMA_OUTPUT_ID, mode: 'append', fromRow: from, rows: run(input, from, emaAt) }];
        }
        case 'updateLast': {
          // Rewind one row (warmup 1): recompute only the last row from e[last − 1].
          const from = Math.max(0, input.length - 1);
          const seed = from > 0 ? emaBefore : Number.NaN;
          return [{ outputId: EMA_OUTPUT_ID, mode: 'updateLast', fromRow: from, rows: run(input, from, seed) }];
        }
        default: {
          // 'replace' | 'insert' | 'reindex' → full rebuild (correctness over cleverness).
          reset();
          return [{ outputId: EMA_OUTPUT_ID, mode: 'replace', fromRow: 0, rows: run(input, 0, Number.NaN) }];
        }
      }
    },
  };
}

/** The EMA IndicatorDefinition: one LineSeries output overlaid on the input's pane. */
export const emaDefinition: IndicatorDefinition<EmaParams> = {
  type: 'ema',
  defaultParams: defaultEmaParams,
  outputs: [{ id: EMA_OUTPUT_ID, definition: LineSeries as SeriesDefinition<SeriesType, unknown, unknown>, pane: 'input' }],
  createComputer: createEmaComputer,
};

// --- the indicator host (the extras `create*` convention; design 05 §5.1) ----------

/** The handle a `createEma` returns: the output series + a Disposable teardown that
 *  removes the output series and unsubscribes from the input (no leak). */
export interface EmaHandle extends Disposable {
  /** The EMA output series (an ordinary LineSeries fed by the input subscription). */
  readonly series: ISeries<SeriesType, Time>;
}

/** A row item the host pushes to the output series: a value row or a whitespace gap. */
type OutItem = { time: Time; value: number } | { time: Time };

/**
 * Attach an EMA indicator to `input` on `chart`. Creates ONE output LineSeries (on the
 * input's pane by default, `pane: 'own'` → a fresh oscillator pane via the public
 * `addSeries(def, opts, paneCount)` — I5), then subscribes to the INPUT series'
 * `subscribeDataChanged` (I1) and, on each diff, runs the computer (reading the input via
 * `input.store()` — I2) and applies each `IndicatorOutputPatch` to the output series via
 * the output's OWN public `setData`/`update` (I3 single ingress — no writer). Because the
 * push runs INSIDE the synchronous data-changed callback, the input + output invalidations
 * coalesce into one frame (I6). The teardown removes the output series and unsubscribes.
 */
export function createEma(
  chart: IChart<Time>,
  input: ISeries<SeriesType, Time>,
  params?: DeepPartial<EmaParams>,
  options?: DeepPartial<unknown>,
): EmaHandle {
  const p: EmaParams =
    params === undefined ? { ...defaultEmaParams } : mergeOptions(defaultEmaParams, params, defaultEmaParams);
  const def = emaDefinition;
  const output = def.outputs[0]!;
  const computer = def.createComputer(p);

  // I5: 'own' opens a fresh pane (paneIndex === paneCount creates it, design 02 §7);
  // 'input' overlays on pane 0 (the input's pane in the headless harness).
  const paneIndex = output.pane === 'own' ? chart.panes().length : undefined;
  const outSeries = chart.addSeries(output.definition, options, paneIndex) as ISeries<SeriesType, Time>;

  // Pair each output value with the TIME of its input row (the host owns the timeline).
  // The computer reads/emits in PLOT-STORE space (whitespace rows EXCLUDED — input.store()
  // length/current(i) only count the finite rows), but the public `input.data()` carries
  // EVERY item including whitespace (TIMELINE/logical space). Indexing data() by the patch's
  // plot-store row would shift every value past a whitespace gap onto the WRONG time. So we
  // first project data() down to the NON-WHITESPACE items' times — a dense array indexed in
  // the SAME plot-store space the computer uses — then `patch.fromRow + k` addresses it
  // correctly. (A `null` output row is whitespace; in plot-store space the computer never
  // emits one for a real row, but we keep the branch defensive.)
  const plotTimes = (): Time[] => {
    const data = input.data() as readonly { time: Time; value?: unknown; open?: unknown }[];
    const times: Time[] = [];
    for (const row of data) {
      // Whitespace = no value-bearing field (the timeline's slot-occupancy rule, design 02
      // §13.1) — excluded from the plot store, so excluded here to stay row-aligned with it.
      if (row.value === undefined && row.open === undefined) continue;
      times.push(row.time);
    }
    return times;
  };

  const itemsFor = (patch: IndicatorOutputPatch): OutItem[] => {
    const times = plotTimes();
    const items: OutItem[] = [];
    for (let k = 0; k < patch.rows.length; k++) {
      const time = times[patch.fromRow + k];
      if (time === undefined) break; // defensive: never read past the input's plot rows
      const v = patch.rows[k];
      items.push(v === null ? { time } : { time, value: v });
    }
    return items;
  };

  // Apply one patch through the OUTPUT series' OWN public setData/update — the single
  // ingress path (I3). 'append'/'updateLast' push the tail via `update`; 'replace'
  // rebuilds via `setData`. NO writer, NO derived store.
  const applyPatch = (patch: IndicatorOutputPatch): void => {
    const items = itemsFor(patch);
    if (patch.mode === 'replace') {
      outSeries.setData(items);
      return;
    }
    // 'append' / 'updateLast': push each tail row via the output's public update().
    for (const it of items) outSeries.update(it);
  };

  // Run the computer on a diff and apply each output patch. Called once for the seed
  // (the input may already hold data at attach time) and on every subsequent diff.
  const recompute = (diff: StoreDiff): void => {
    for (const patch of computer.apply(diff, input.store())) applyPatch(patch);
  };

  // Seed from the input's CURRENT data (a 'replace' full rebuild), then subscribe (I1).
  recompute({ kind: 'replace' });
  const off: Unsubscribe = input.subscribeDataChanged(recompute);

  let disposed = false;
  return {
    series: outSeries,
    dispose(): void {
      if (disposed) return; // idempotent
      disposed = true;
      off();
      chart.removeSeries(outSeries);
    },
  };
}
