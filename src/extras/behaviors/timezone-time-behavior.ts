// traderzview · extras/behaviors — session-local TIME behavior (design 05 §7.1; the S1
// in-tree proof). `timezoneTimeBehavior(tz)` produces an IHorzScaleBehavior<Time> whose
// LABELS and WEIGHT BUCKETING land where the trader's WALL CLOCK says, not at UTC
// midnight: day/session boundaries bucket on `utc + offset(utc)`, and tick/crosshair
// labels render shifted wall-clock fields. Storage stays UTC forever — timezones NEVER
// re-key data (study 03 §5); this is a display + bucketing concern only.
//
// The seam (design 05 §7.1 / A-5): the optional `timezoneOffset?(item): number` hook on
// IHorzScaleBehavior, consulted by the behavior's OWN fillWeights/formatTick. The IANA→
// offset resolution lives ENTIRELY here in extras (the core never sees a zone name): an
// `Intl.DateTimeFormat`-backed `offsetFor(tz)` computes the UTC offset (seconds) for any
// instant, memoized per ~6-month segment so DST transitions resolve without re-parsing
// every tick.
//
// Per A-5, the canonical wiring is `timezoneTimeBehavior(tz) ≡ timeBehavior({
// timezoneOffset: offsetFor(tz) })` — constructor injection into the CORE time behavior,
// whose fillWeights/formatTick consult `this.timezoneOffset`. The shipped public
// `timeBehavior()` takes NO options and its fillWeights/formatTick do not yet read the
// hook (see missingSeams), so this factory installs the hook AND supplies the offset-aware
// fillWeights/formatTick itself, delegating every UTC-invariant member (key/cacheKey/
// toInternal/maxTickWeight/augmentDefaults) to the base behavior — reimplementing nothing
// the core already owns beyond the two methods the hook is meant to steer. When the core
// gains the §7.1 consult, this collapses to the one-line A-5 form with no caller change.
//
// Built ONLY on the PUBLIC api seams (timeBehavior value export + IHorzScaleBehavior /
// HorzPoint / Time types, design 02 §3.1/§13.3) + the core HorzKey brand — never model/
// views (arch §3.1; dep-cruiser E1).
import { timeBehavior } from '../../api';
import type { HorzPoint, IHorzScaleBehavior, Time } from '../../api';

// The behavior's opaque internal item is the base time behavior's `{ timestamp; businessDay? }`
// (design 02 §13.3). It is NOT on the public barrel, so we model the one field we read
// (the UTC timestamp in seconds) structurally — never importing data/horz-behavior deeply.
interface TimeInternalLike {
  readonly timestamp: number; // UTC seconds
  readonly businessDay?: { year: number; month: number; day: number };
}

// --- IANA → offset (seconds), memoized per ~6-month DST segment (design 05 §7.1) -----

/**
 * Build `(utc: number) => seconds`: the UTC offset (in SECONDS, east-positive) for the
 * given IANA zone at a UTC instant (the timestamp is UTC seconds). Uses
 * `Intl.DateTimeFormat` formatToParts to read the zone's wall-clock fields and differs
 * them against the UTC fields. Memoized per ~6-month bucket of the instant so two ticks
 * in the same DST segment share one Intl computation (study 03 §7.1 caching note). The
 * known caveat (a locale formatter may still consult the environment zone) is documented
 * on the factory. A zone the runtime cannot resolve falls back to offset 0 (UTC).
 */
export function offsetFor(tz: string): (utc: number) => number {
  // Lazily construct the formatter once; an invalid zone throws → we fall back to UTC.
  let fmt: Intl.DateTimeFormat | null = null;
  let usable = true;
  const ensure = (): Intl.DateTimeFormat | null => {
    if (fmt === null && usable) {
      try {
        fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hourCycle: 'h23',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        });
      } catch {
        usable = false; // unresolvable zone → permanent UTC fallback
      }
    }
    return fmt;
  };

  const SEGMENT = 15552000; // ~180 days in seconds — one DST segment bucket
  const cache = new Map<number, number>();

  return (utc: number): number => {
    const bucket = Math.floor(utc / SEGMENT);
    const hit = cache.get(bucket);
    if (hit !== undefined) return hit;
    const f = ensure();
    let offset = 0;
    if (f !== null) {
      // Read the zone's wall-clock fields for this instant, rebuild them as a UTC instant,
      // and the difference (zone-wall − utc) IS the offset.
      const parts = f.formatToParts(new Date(utc * 1000));
      const get = (t: string): number => {
        const p = parts.find((x) => x.type === t);
        return p === undefined ? 0 : Number(p.value);
      };
      const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
      offset = Math.round((asUtc - utc * 1000) / 1000);
    }
    cache.set(bucket, offset);
    return offset;
  };
}

// --- session-local weight buckets (mirror the core bands on the SHIFTED instant) ------

const W_YEAR = 70;
const W_MONTH = 60;
const W_DAY = 50;
const W_HOUR = 30;
const W_MINUTE = 20;
const W_SECOND = 10;
const W_SUBSECOND = 0;

/** Weight between two SHIFTED (session-local) instants in ms — the core's day/hour/…
 *  ladder evaluated on wall-clock fields so a session boundary bolds in LOCAL time. */
function localWeight(curMs: number, prevMs: number): number {
  const c = new Date(curMs);
  const p = new Date(prevMs);
  if (c.getUTCFullYear() !== p.getUTCFullYear()) return W_YEAR;
  if (c.getUTCMonth() !== p.getUTCMonth()) return W_MONTH;
  if (c.getUTCDate() !== p.getUTCDate()) return W_DAY;
  if (c.getUTCHours() !== p.getUTCHours()) return W_HOUR;
  if (c.getUTCMinutes() !== p.getUTCMinutes()) return W_MINUTE;
  if (c.getUTCSeconds() !== p.getUTCSeconds()) return W_SECOND;
  return W_SUBSECOND;
}

/** Two-digit zero-pad. */
function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

// --- the wrapped behavior -----------------------------------------------------------

/**
 * The session-local time behavior (design 05 §7.1 / A-5). `tz` is an IANA zone name
 * (`'America/New_York'`, `'Asia/Tokyo'`, …). Returns an IHorzScaleBehavior<Time>:
 *
 *  - `timezoneOffset(item)` — the A-5 hook, installed here (offset in SECONDS at the
 *    item's UTC instant via {@link offsetFor}).
 *  - `fillWeights` buckets on `utc + offset(utc)` so day/session boundaries land at LOCAL
 *    midnight (S1) — minting weights on the same open scale the core uses.
 *  - `formatTick` / `formatItem` render SHIFTED wall-clock fields (HH:mm local, the local
 *    calendar date) — UTC storage unchanged.
 *  - every UTC-invariant member (`key`/`cacheKey`/`toInternal`/`maxTickWeight`/
 *    `augmentDefaults`) delegates to the base `timeBehavior()` (no reimplementation).
 *
 * CAVEAT (study 03 §5, repeated): a user `timeFormatter`/`tickMarkFormatter` that itself
 * calls a locale formatter may consult the ENVIRONMENT zone; the shift here covers the
 * library's own default rendering and the weight bucketing.
 */
export function timezoneTimeBehavior(tz: string): IHorzScaleBehavior<Time> {
  const base = timeBehavior() as unknown as IHorzScaleBehavior<Time, TimeInternalLike>;
  const offset = offsetFor(tz);
  // The UTC seconds for an internal item: a business-day item is UTC midnight; a timestamp
  // item is its instant. (Mirrors the base behavior's instantOf, on the field we can read.)
  const utcSecondsOf = (item: TimeInternalLike): number => {
    if (item.businessDay !== undefined) {
      return Math.round(Date.UTC(item.businessDay.year, item.businessDay.month - 1, item.businessDay.day) / 1000);
    }
    return item.timestamp;
  };
  // The SHIFTED instant (ms) whose UTC-read fields equal the zone's wall clock.
  const shiftedMs = (item: TimeInternalLike): number => {
    const utc = utcSecondsOf(item);
    return (utc + offset(utc)) * 1000;
  };

  const wrapped: IHorzScaleBehavior<Time, TimeInternalLike> = {
    // --- delegated, UTC-invariant members (the core already owns these) -------------
    key: (item) => base.key(item),
    cacheKey: (item) => base.cacheKey(item),
    toInternal: (items) => base.toInternal(items),
    maxTickWeight: (weights) => base.maxTickWeight(weights),
    augmentDefaults: (defaults) => base.augmentDefaults(defaults),

    // --- the A-5 hook installed in extras (offset in seconds at the item's instant) --
    timezoneOffset: (item) => offset(utcSecondsOf(item)),

    // --- offset-aware bucketing (S1): the core's ladder on the SHIFTED instant -------
    fillWeights: (points: readonly HorzPoint<TimeInternalLike>[], startIndex: number): void => {
      const n = points.length;
      if (n === 0) return;
      let prevMs = startIndex > 0 ? shiftedMs(points[startIndex - 1]!.item) : null;
      let totalDiff = 0;
      for (let i = startIndex; i < n; i++) {
        const curMs = shiftedMs(points[i]!.item);
        if (prevMs !== null) {
          points[i]!.weight = localWeight(curMs, prevMs);
          totalDiff += curMs - prevMs;
        }
        prevMs = curMs;
      }
      if (startIndex === 0 && n > 1) {
        const avg = Math.ceil(totalDiff / (n - 1));
        const firstMs = shiftedMs(points[0]!.item);
        points[0]!.weight = localWeight(firstMs, firstMs - avg);
      }
    },

    // --- offset-aware labels (S1): render SHIFTED wall-clock fields ------------------
    formatTick: (item, weight, loc, fmt) => {
      // a user tickMarkFormatter still wins (it gets the original UTC value via the base).
      if (fmt.tickMarkFormatter !== undefined) {
        const t = base.formatTick(item, weight, loc, fmt);
        return t; // the base routed it through the user hook already
      }
      const d = new Date(shiftedMs(item));
      // day-or-coarser weights → local calendar date; finer → local HH:mm(:ss).
      if (weight >= W_DAY) return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
      const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
      return fmt.secondsVisible && weight <= W_SECOND ? `${hm}:${pad2(d.getUTCSeconds())}` : hm;
    },
    formatItem: (item, loc, fmt) => {
      if (loc.timeFormatter !== undefined) return base.formatItem(item, loc, fmt);
      const d = new Date(shiftedMs(item));
      const date = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
      if (!fmt.timeVisible) return date;
      const hm = `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
      const time = fmt.secondsVisible ? `${hm}:${pad2(d.getUTCSeconds())}` : hm;
      return `${date}   ${time}`;
    },
  };

  return wrapped as unknown as IHorzScaleBehavior<Time>;
}
