// Data validation tiers (design 02 §15, architecture §4.5 item 4 / D8). The cheap
// tier is ALWAYS on (subject to the `validation` option) — silent corruption from
// unsorted data is the #1 user footgun, so unlike the reference we do not ship a
// prod-silently-accepts-garbage path. The expensive tier (OHLC sanity) is dev-only.
//
//   'throw' (default) — raise on the first offense, carrying the item index and
//                       both offending keys.
//   'warn'            — log ONCE per call and DROP offending items (chart stays
//                       consistent: the kept keys remain strictly ascending).
//   'off'             — skip the cheap tier (the documented "you own the
//                       corruption" benchmark escape hatch).
import type { IHorzScaleBehavior } from './horz-behavior';
import type { SeriesDataContract } from './series-contract';

export type ValidationMode = 'throw' | 'warn' | 'off';

export interface ValidationOptions {
  validation: ValidationMode;
}

/** Magnitude bound (design 02 §15): |v| ≤ 2^53 / 100. */
const MAX_MAGNITUDE = Math.pow(2, 53) / 100;
const DATE_STRING = /^\d{4}-\d{2}-\d{2}$/;

interface TimedItem {
  time: unknown;
}

/** Minimal local error type — model/api own the full ChartError taxonomy (design 02 §16). */
class DataValidationError extends Error {
  constructor(message: string) {
    super(`[traderzview] ${message}`);
    this.name = 'DataValidationError';
  }
}

/**
 * Validate one series' batch. Returns the items to keep: the SAME array reference
 * when nothing is dropped (and always for `'off'`); a filtered copy in `'warn'`
 * mode. Never mutates the input. Throws `DataValidationError` in `'throw'` mode.
 */
export function validateSeriesData<TItem extends TimedItem, H, I>(
  items: readonly TItem[],
  contract: SeriesDataContract<TItem>,
  behavior: IHorzScaleBehavior<H, I>,
  options: ValidationOptions,
): readonly TItem[] {
  if (options.validation === 'off') return items;
  const warn = options.validation === 'warn';

  const lanes = new Float64Array(contract.laneCount);
  const kept: TItem[] = [];
  let warned = false;
  let prevKey: number | null = null;

  const report = (index: number, reason: string): boolean => {
    // returns true if the offending item should be SKIPPED (warn), false to keep.
    if (warn) {
      if (!warned) {
        warned = true;
        console.warn(`[traderzview] dropped invalid series data: ${reason} (item index ${index})`);
      }
      return true;
    }
    throw new DataValidationError(`${reason} (item index ${index})`);
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // date-string regex (always-on cheap tier; deterministic regardless of build).
    const t = item.time;
    if (typeof t === 'string' && !DATE_STRING.test(t)) {
      if (report(i, `invalid date string ${JSON.stringify(t)} (expected yyyy-mm-dd)`)) continue;
    }

    const key = behavior.key(item.time as H | I) as unknown as number;

    // strictly-ascending + unique keys.
    if (prevKey !== null && key <= prevKey) {
      if (
        report(
          i,
          `keys must be strictly ascending and unique: key ${key} is not greater than the previous key ${prevKey}`,
        )
      ) {
        continue; // drop; do NOT advance prevKey so the chart stays consistent
      }
    }

    // per-lane finite + magnitude bound (whitespace has no lanes to check).
    if (!contract.isWhitespace(item)) {
      contract.extractLanes(item, lanes, 0);
      let bad: string | null = null;
      for (let n = 0; n < contract.laneCount; n++) {
        const val = lanes[n];
        if (!Number.isFinite(val)) {
          bad = `non-finite value ${val} in lane ${n}`;
          break;
        }
        if (Math.abs(val) > MAX_MAGNITUDE) {
          bad = `value ${val} exceeds the magnitude bound 2^53/100 in lane ${n}`;
          break;
        }
      }
      // dev-only expensive tier: OHLC sanity (high ≥ max(open,close), low ≤ min).
      if (bad === null && __DEV__ && contract.laneCount === 4) {
        const open = lanes[0];
        const high = lanes[1];
        const low = lanes[2];
        const close = lanes[3];
        if (high < Math.max(open, close)) bad = `high ${high} below max(open,close)`;
        else if (low > Math.min(open, close)) bad = `low ${low} above min(open,close)`;
      }
      if (bad !== null) {
        if (report(i, bad)) continue;
      }
    }

    prevKey = key;
    if (warn) kept.push(item);
  }

  return warn ? kept : items;
}
