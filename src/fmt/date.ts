// Date/time formatting primitives (design 02 §6.7). The time horizontal-scale
// behavior (data/extras) composes these in its formatItem/formatTick; fmt only
// provides the primitives. All conversions are UTC — sessions/timezones are a
// post-v1 concern routed through the behavior's optional timezoneOffset hook.

/** The default `localization.dateFormat` (design 02 §6.7). */
export const DEFAULT_DATE_FORMAT = "dd MMM 'yy";

// Intl.DateTimeFormat construction is comparatively expensive; cache one instance
// per (locale, style). Output strings are additionally cached by FormattedLabelsCache.
const monthFormatters = new Map<string, Intl.DateTimeFormat>();

function monthName(date: Date, locale: string, style: 'long' | 'short'): string {
  const key = `${locale}|${style}`;
  let fmt = monthFormatters.get(key);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat(locale || undefined, { month: style, timeZone: 'UTC' });
    monthFormatters.set(key, fmt);
  }
  return fmt.format(date);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Format a Date by a token string (UTC). Tokens, replaced longest-first so a
 * shorter token never eats a longer one: `yyyy` `yy` `MMMM` `MMM` `MM` `dd`.
 * Any other characters are literal (e.g. the `'` in `dd MMM 'yy`).
 */
export function formatDate(date: Date, format: string, locale: string): string {
  const yyyy = String(date.getUTCFullYear());
  return format
    .replace(/yyyy/g, yyyy)
    .replace(/yy/g, yyyy.slice(-2))
    .replace(/MMMM/g, monthName(date, locale, 'long'))
    .replace(/MMM/g, monthName(date, locale, 'short'))
    .replace(/MM/g, pad2(date.getUTCMonth() + 1))
    .replace(/dd/g, pad2(date.getUTCDate()));
}

/** `HH:mm:ss` in UTC — the intraday time primitive for tick/crosshair labels. */
export function formatTime(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}
