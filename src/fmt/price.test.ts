import { describe, expect, test } from 'vitest';
import { percentFormatter, precisionByMinMove, priceFormatter, volumeFormatter } from './price';

const MINUS = '−'; // U+2212, the PriceFormatter sign (not ASCII '-')

describe('precisionByMinMove (study 09 §4.3)', () => {
  test('whole tick → 0 decimals', () => {
    expect(precisionByMinMove(1)).toBe(0);
    expect(precisionByMinMove(5)).toBe(0);
  });
  test('fractional ticks', () => {
    expect(precisionByMinMove(0.5)).toBe(1);
    expect(precisionByMinMove(0.1)).toBe(1);
    expect(precisionByMinMove(0.25)).toBe(2);
    expect(precisionByMinMove(0.01)).toBe(2);
    expect(precisionByMinMove(0.001)).toBe(3);
    expect(precisionByMinMove(0.0001)).toBe(4);
  });
});

describe('priceFormatter — type price (study 04 §4.9)', () => {
  test('default precision 2, minMove 0.01', () => {
    const f = priceFormatter(2, 0.01);
    expect(f.format(1.5)).toBe('1.50');
    expect(f.format(0)).toBe('0.00');
    expect(f.format(2)).toBe('2.00');
    expect(f.format(1234.567)).toBe('1234.57');
  });

  test('negative values use the U+2212 minus sign', () => {
    const f = priceFormatter(2, 0.01);
    expect(f.format(-2.5)).toBe(`${MINUS}2.50`);
  });

  test('rounds at the tick via integer arithmetic (faithful to IEEE-754)', () => {
    const f = priceFormatter(2, 0.01);
    expect(f.format(1.125)).toBe('1.13'); // 112.5 → 113 (half-up)
    expect(f.format(1.124)).toBe('1.12'); // rounds down
    // 1.005 * 100 === 100.4999… in IEEE-754, so it rounds DOWN — matches the
    // reference's round(value * coeff). Not "1.01".
    expect(f.format(1.005)).toBe('1.00');
  });

  test('carry rolls the integer part', () => {
    const f = priceFormatter(2, 0.01);
    expect(f.format(0.999)).toBe('1.00');
  });

  test('precision 4, minMove 0.0001', () => {
    const f = priceFormatter(4, 0.0001);
    expect(f.format(1.23456)).toBe('1.2346');
  });

  test('snaps to a non-decimal minMove (0.05)', () => {
    const f = priceFormatter(2, 0.05);
    expect(f.format(1.23)).toBe('1.25');
    expect(f.format(1.22)).toBe('1.20');
  });

  test('precision 0 on integers', () => {
    const f = priceFormatter(0, 1);
    expect(f.format(5)).toBe('5');
    expect(f.format(-3)).toBe(`${MINUS}3`);
  });

  test('non-finite input → "n/a"', () => {
    const f = priceFormatter(2, 0.01);
    expect(f.format(Number.NaN)).toBe('n/a');
  });
});

describe('percentFormatter — price formatter plus a trailing %', () => {
  test('appends % and keeps the U+2212 sign', () => {
    const f = percentFormatter(2, 0.01);
    expect(f.format(12.5)).toBe('12.50%');
    expect(f.format(-3)).toBe(`${MINUS}3.00%`);
  });
});

describe('volumeFormatter — K/M/B thresholds (study 04 §4.9)', () => {
  test('plain below 995', () => {
    const f = volumeFormatter(2);
    expect(f.format(500)).toBe('500');
    expect(f.format(0)).toBe('0');
  });

  test('K / M / B suffixes', () => {
    const f = volumeFormatter(2);
    expect(f.format(1500)).toBe('1.5K');
    expect(f.format(1234)).toBe('1.23K');
    expect(f.format(1_500_000)).toBe('1.5M');
    expect(f.format(2_500_000_000)).toBe('2.5B');
  });

  test('negatives use the ASCII minus (not U+2212)', () => {
    expect(volumeFormatter(2).format(-1500)).toBe('-1.5K');
  });

  test('precision 0 rounds the mantissa', () => {
    expect(volumeFormatter(0).format(1500)).toBe('2K');
  });
});
