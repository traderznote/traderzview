import { describe, expect, test } from 'vitest';
import { DEFAULT_DATE_FORMAT, formatDate, formatTime } from './date';

// 2026-06-14 09:07:03 UTC (month index 5 = June).
const d = new Date(Date.UTC(2026, 5, 14, 9, 7, 3));

describe('formatDate — tokens yyyy yy MMMM MMM MM dd (UTC)', () => {
  test('default format "dd MMM \'yy"', () => {
    expect(DEFAULT_DATE_FORMAT).toBe("dd MMM 'yy");
    expect(formatDate(d, DEFAULT_DATE_FORMAT, 'en-US')).toBe("14 Jun '26");
  });

  test('numeric tokens zero-pad', () => {
    expect(formatDate(d, 'yyyy-MM-dd', 'en-US')).toBe('2026-06-14');
    const jan3 = new Date(Date.UTC(2026, 0, 3));
    expect(formatDate(jan3, 'yyyy-MM-dd', 'en-US')).toBe('2026-01-03');
  });

  test('long vs short month names', () => {
    expect(formatDate(d, 'dd MMMM yyyy', 'en-US')).toBe('14 June 2026');
    expect(formatDate(d, 'MMM', 'en-US')).toBe('Jun');
  });

  test('two-digit year token', () => {
    expect(formatDate(d, 'yy', 'en-US')).toBe('26');
  });
});

describe('formatTime — HH:mm:ss (UTC)', () => {
  test('zero-pads hours, minutes, seconds', () => {
    expect(formatTime(d)).toBe('09:07:03');
  });
});
