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
// whose fillWeights/formatTick consult `this.timezoneOffset`. The core now ships that
// §7.1 consult (the FIX 4/5 seam), so this factory collapses to exactly the one-line A-5
// form: it resolves the IANA zone to an offset fn HERE in extras and hands it to the core
// constructor. The core owns the offset-aware fillWeights/formatTick (bucketing on the
// shifted instant + rendering shifted wall-clock fields); extras reimplements NONE of it.
//
// Built ONLY on the PUBLIC api seams (timeBehavior value export + IHorzScaleBehavior / Time
// types, design 02 §3.1/§13.3) — never model/views (arch §3.1; dep-cruiser E1).
import { timeBehavior } from '../../api';
import type { IHorzScaleBehavior, Time } from '../../api';

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

// --- the A-5 wired behavior ----------------------------------------------------------

/**
 * The session-local time behavior (design 05 §7.1 / A-5). `tz` is an IANA zone name
 * (`'America/New_York'`, `'Asia/Tokyo'`, …). The IANA→offset resolution lives ENTIRELY
 * here in extras ({@link offsetFor}); the resolved offset fn is injected into the CORE
 * time behavior via the FIX 5 seam, so:
 *
 *  - `timezoneOffset(item)` — the A-5 hook, wired by the core from `offsetFor(tz)`.
 *  - `fillWeights` (core) buckets on `utc + offset(utc)` so day/session boundaries land at
 *    LOCAL midnight (S1).
 *  - `formatTick` (core) renders SHIFTED wall-clock fields (the local hour/day) — UTC
 *    storage unchanged (study 03 §5: never re-key data; display + bucketing only).
 *  - every other member is the core's own (key/cacheKey/toInternal/maxTickWeight/
 *    augmentDefaults/formatItem) — extras reimplements NOTHING.
 *
 * CAVEAT (study 03 §5, repeated): a user `timeFormatter`/`tickMarkFormatter` that itself
 * calls a locale formatter may consult the ENVIRONMENT zone; the shift here covers the
 * library's own default rendering and the weight bucketing.
 */
export function timezoneTimeBehavior(tz: string): IHorzScaleBehavior<Time> {
  // The canonical A-5 form: resolve IANA→offset in extras, inject into the core seam. The
  // core's offset-aware fillWeights/formatTick (FIX 4) do the shifted bucketing + labels.
  return timeBehavior({ timezoneOffset: offsetFor(tz) }) as unknown as IHorzScaleBehavior<Time>;
}
