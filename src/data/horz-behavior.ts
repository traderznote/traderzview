// The horizontal-scale behavior seam (design 02 §13.3, architecture §4.5.5) and
// the built-in UTC time behavior (study 03 §2/§4.8/§4.13 are the spec of record).
//
// IHorzScaleBehavior<H, I> is the strategy that makes the time scale data-type
// agnostic: the core round-trips `I` (the behavior's self-chosen internal item)
// and only ever asks for a numeric `key` (ordering), `cacheKey` (label caching),
// weights, and formatting. The time behavior's `I` is { timestamp; businessDay? }.
import { DEFAULT_DATE_FORMAT, formatDate, formatTime } from '../fmt';
import type { HorzKey } from '../core';
import { TickMarkType } from './options-groups';
import type {
  HorzScaleOptionGroups,
  LocalizationOptions,
  TimeScaleFormatOptions,
} from './options-groups';

export type { HorzScaleOptionGroups, LocalizationOptions, TimeScaleFormatOptions };
export { TickMarkType };

// --- public types (design 02 §13.1 / §13.3) -------------------------------------

export type UTCTimestamp = number;
export interface BusinessDay {
  year: number;
  month: number; // 1-based
  day: number;
}
/** A user-facing horizontal value for the time behavior (design 02 §13.1). */
export type Time = UTCTimestamp | number | BusinessDay | string;

/** One slot on the merged timeline as the behavior sees it; fillWeights writes `weight`. */
export interface HorzPoint<I> {
  readonly item: I;
  readonly key: HorzKey;
  weight: number;
}

/**
 * The 9-member strategy surface (design 02 §13.3, verbatim). `H` = the user time
 * form; `I` = the behavior's opaque internal item, defaulted to `H`.
 */
export interface IHorzScaleBehavior<H, I = H> {
  key(item: H | I): HorzKey; // sortable numeric key (ordering, search, dedup)
  cacheKey(item: I): number; // label-cache identity
  toInternal(items: readonly H[]): (item: H) => I; // ONE per-batch converter factory
  formatItem(item: I, loc: LocalizationOptions<H>, fmt: TimeScaleFormatOptions<H>): string;
  formatTick(item: I, weight: number, loc: LocalizationOptions<H>, fmt: TimeScaleFormatOptions<H>): string;
  fillWeights(points: readonly HorzPoint<I>[], startIndex: number): void;
  maxTickWeight(weights: readonly number[]): number;
  augmentDefaults(defaults: HorzScaleOptionGroups<H>): void;
  timezoneOffset?(item: I): number;
}

// --- time behavior internal item ------------------------------------------------

/** The time behavior's opaque internal item (design 02 §13.3). */
export interface TimeInternal {
  readonly timestamp: UTCTimestamp; // seconds, UTC
  readonly businessDay?: BusinessDay;
}

// --- weight bands (study 03 §2, exact) ------------------------------------------

const WEIGHT_LESS_THAN_SECOND = 0;
const WEIGHT_SECOND = 10;
const WEIGHT_MINUTE1 = 20;
const WEIGHT_MINUTE5 = 21;
const WEIGHT_MINUTE30 = 22;
const WEIGHT_HOUR1 = 30;
const WEIGHT_DAY = 50;
const WEIGHT_MONTH = 60;
const WEIGHT_YEAR = 70;

// intraday divisor table, largest → smallest (study 03 §4.10). Each is a bucket
// width in milliseconds and the weight for crossing one of its boundaries.
const INTRADAY: ReadonlyArray<readonly [number, number]> = [
  [12 * 3600_000, 33], // Hour12
  [6 * 3600_000, 32], // Hour6
  [3 * 3600_000, 31], // Hour3
  [3600_000, WEIGHT_HOUR1], // Hour1
  [30 * 60_000, WEIGHT_MINUTE30],
  [5 * 60_000, WEIGHT_MINUTE5],
  [60_000, WEIGHT_MINUTE1],
  [1000, WEIGHT_SECOND],
];

// --- time conversion (study 03 §3.4) --------------------------------------------

const DATE_STRING = /^\d{4}-\d{2}-\d{2}$/;

function isBusinessDay(t: Time): t is BusinessDay {
  return typeof t !== 'number' && typeof t !== 'string';
}

function businessDayToTimestamp(bd: BusinessDay): number {
  return Math.round(Date.UTC(bd.year, bd.month - 1, bd.day, 0, 0, 0, 0) / 1000);
}

function parseDateString(s: string): BusinessDay {
  if (__DEV__ && !DATE_STRING.test(s)) {
    throw new Error(`[traderzview] invalid date string: ${JSON.stringify(s)} (expected yyyy-mm-dd)`);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`[traderzview] invalid date string: ${JSON.stringify(s)}`);
  }
  // Read back as UTC fields (study 03 §3.4): a fresh business-day object, never
  // mutating the user's input.
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function timestampConverter(item: Time): TimeInternal {
  if (typeof item !== 'number') {
    throw new Error('[traderzview] expected a UTC timestamp number');
  }
  return { timestamp: item };
}

function businessDayConverter(item: Time): TimeInternal {
  const bd = typeof item === 'string' ? parseDateString(item) : (item as BusinessDay);
  return { timestamp: businessDayToTimestamp(bd), businessDay: { year: bd.year, month: bd.month, day: bd.day } };
}

// --- the instant a tick/label renders -------------------------------------------

function instantOf(item: TimeInternal): Date {
  // business day → UTC midnight; else the timestamp instant (seconds → ms).
  return item.businessDay !== undefined
    ? new Date(Date.UTC(item.businessDay.year, item.businessDay.month - 1, item.businessDay.day))
    : new Date(item.timestamp * 1000);
}

/** The user value `originalTime` would round-trip — what user formatters receive. */
function originalOf(item: TimeInternal): Time {
  return item.businessDay !== undefined ? { ...item.businessDay } : (item.timestamp as UTCTimestamp);
}

// --- weight assignment (study 03 §4.10) -----------------------------------------

function weightByTime(curMs: number, prevMs: number): number {
  const cur = new Date(curMs);
  const prev = new Date(prevMs);
  if (cur.getUTCFullYear() !== prev.getUTCFullYear()) return WEIGHT_YEAR;
  if (cur.getUTCMonth() !== prev.getUTCMonth()) return WEIGHT_MONTH;
  if (cur.getUTCDate() !== prev.getUTCDate()) return WEIGHT_DAY;
  for (const [divisor, weight] of INTRADAY) {
    if (Math.floor(prevMs / divisor) !== Math.floor(curMs / divisor)) return weight;
  }
  return WEIGHT_LESS_THAN_SECOND;
}

// --- formatting (study 03 §4.13) ------------------------------------------------

function weightToType(weight: number, timeVisible: boolean, secondsVisible: boolean): TickMarkType {
  if (weight >= WEIGHT_YEAR) return TickMarkType.Year;
  if (weight >= WEIGHT_MONTH) return TickMarkType.Month;
  if (weight >= WEIGHT_DAY) return TickMarkType.DayOfMonth;
  if (!timeVisible) return TickMarkType.DayOfMonth;
  return weight <= WEIGHT_SECOND && secondsVisible ? TickMarkType.TimeWithSeconds : TickMarkType.Time;
}

function defaultTickLabel(item: TimeInternal, type: TickMarkType, locale: string): string {
  const d = instantOf(item);
  switch (type) {
    case TickMarkType.Year:
      return String(d.getUTCFullYear());
    case TickMarkType.Month:
      return formatDate(d, 'MMM', locale);
    case TickMarkType.DayOfMonth:
      return String(d.getUTCDate());
    case TickMarkType.TimeWithSeconds:
      return formatTime(d); // HH:mm:ss
    default: {
      const hms = formatTime(d);
      return hms.slice(0, 5); // HH:mm
    }
  }
}

const timeBehaviorImpl: IHorzScaleBehavior<Time, TimeInternal> = {
  key(item: Time | TimeInternal): HorzKey {
    // an internal item carries `timestamp`; a raw user value is converted first.
    if (typeof item === 'object' && item !== null && 'timestamp' in item) {
      return (item as TimeInternal).timestamp as unknown as HorzKey;
    }
    const t = item as Time;
    if (typeof t === 'number') return t as unknown as HorzKey;
    if (typeof t === 'string') return businessDayToTimestamp(parseDateString(t)) as unknown as HorzKey;
    return businessDayToTimestamp(t) as unknown as HorzKey;
  },

  cacheKey(item: TimeInternal): number {
    return item.businessDay !== undefined
      ? Date.UTC(item.businessDay.year, item.businessDay.month - 1, item.businessDay.day)
      : item.timestamp * 1000;
  },

  toInternal(items: readonly Time[]): (item: Time) => TimeInternal {
    // pick ONE converter for the whole batch from the first item (study 03 §3.4).
    const first = items.length > 0 ? items[0] : undefined;
    const useBusinessDay = first !== undefined && (typeof first === 'string' || isBusinessDay(first));
    return useBusinessDay ? businessDayConverter : timestampConverter;
  },

  formatItem(item: TimeInternal, loc: LocalizationOptions<Time>, fmt: TimeScaleFormatOptions<Time>): string {
    if (loc.timeFormatter !== undefined) return loc.timeFormatter(originalOf(item));
    const d = instantOf(item);
    const datePart = formatDate(d, loc.dateFormat, loc.locale);
    if (!fmt.timeVisible) return datePart;
    const hms = formatTime(d);
    const timePart = fmt.secondsVisible ? hms : hms.slice(0, 5);
    return `${datePart}   ${timePart}`; // 3-space separator (study 03 §4.13)
  },

  formatTick(
    item: TimeInternal,
    weight: number,
    loc: LocalizationOptions<Time>,
    fmt: TimeScaleFormatOptions<Time>,
  ): string {
    const type = weightToType(weight, fmt.timeVisible, fmt.secondsVisible);
    if (fmt.tickMarkFormatter !== undefined) {
      const out = fmt.tickMarkFormatter(originalOf(item), type, loc.locale);
      if (out !== null) return out;
    }
    return defaultTickLabel(item, type, loc.locale);
  },

  fillWeights(points: readonly HorzPoint<TimeInternal>[], startIndex: number): void {
    const n = points.length;
    if (n === 0) return;
    let prevMs = startIndex > 0 ? points[startIndex - 1].item.timestamp * 1000 : null;
    let totalTimeDiff = 0;
    for (let i = startIndex; i < n; i++) {
      const curMs = points[i].item.timestamp * 1000;
      if (prevMs !== null) {
        points[i].weight = weightByTime(curMs, prevMs);
        totalTimeDiff += curMs - prevMs;
      }
      prevMs = curMs;
    }
    if (startIndex === 0 && n > 1) {
      // the first point has no predecessor: invent one an average gap back.
      const avg = Math.ceil(totalTimeDiff / (n - 1));
      const firstMs = points[0].item.timestamp * 1000;
      points[0].weight = weightByTime(firstMs, firstMs - avg);
    }
  },

  maxTickWeight(weights: readonly number[]): number {
    let max = 0;
    for (const w of weights) if (w > max) max = w;
    // quirk (study 03 §4.13): a max strictly between Hour1 and Day is reduced to
    // Hour1 — so 15:00 isn't bolded while 14:00 isn't.
    if (max > WEIGHT_HOUR1 && max < WEIGHT_DAY) max = WEIGHT_HOUR1;
    return max;
  },

  augmentDefaults(defaults: HorzScaleOptionGroups<Time>): void {
    defaults.localization.dateFormat = DEFAULT_DATE_FORMAT;
  },
};

/** Factory for the UTC time behavior (architecture §8: injected by createChart). */
export function timeBehavior(): IHorzScaleBehavior<Time, TimeInternal> {
  return timeBehaviorImpl;
}
