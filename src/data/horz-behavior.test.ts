import { describe, expect, test } from 'vitest';
import { DEFAULT_DATE_FORMAT } from '../fmt';
import type { HorzKey } from '../core';
import { timeBehavior } from './horz-behavior';
import type { TimeInternal } from './horz-behavior';
import { TickMarkType } from './options-groups';
import type { HorzScaleOptionGroups, LocalizationOptions, TimeScaleFormatOptions } from './options-groups';

// Seconds for a UTC instant.
const ts = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  Math.round(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);

const loc = (over: Partial<LocalizationOptions> = {}): LocalizationOptions => ({
  locale: 'en-US',
  dateFormat: DEFAULT_DATE_FORMAT,
  priceFormatter: undefined,
  percentageFormatter: undefined,
  timeFormatter: undefined,
  ...over,
});

const fmtOpts = (over: Partial<TimeScaleFormatOptions> = {}): TimeScaleFormatOptions => ({
  timeVisible: false,
  secondsVisible: true,
  tickMarkFormatter: undefined,
  ...over,
});

describe('timeBehavior — key / cacheKey / toInternal', () => {
  test('key of a raw timestamp number is the timestamp (seconds)', () => {
    const b = timeBehavior();
    expect(b.key(ts(2024, 1, 2))).toBe(ts(2024, 1, 2) as unknown as HorzKey);
  });

  test('key of an internal item reads its timestamp', () => {
    const b = timeBehavior();
    const conv = b.toInternal([1700000000]);
    const internal = conv(1700000000);
    expect(b.key(internal)).toBe(1700000000 as unknown as HorzKey);
  });

  test('key of a business day = UTC-midnight seconds', () => {
    const b = timeBehavior();
    expect(b.key({ year: 2024, month: 3, day: 15 })).toBe(ts(2024, 3, 15) as unknown as HorzKey);
  });

  test('key of a yyyy-mm-dd string = UTC-midnight seconds', () => {
    const b = timeBehavior();
    expect(b.key('2024-03-15')).toBe(ts(2024, 3, 15) as unknown as HorzKey);
  });

  test('timestamp converter yields {timestamp} with NO businessDay', () => {
    const b = timeBehavior();
    const conv = b.toInternal([1700000000, 1700086400]);
    const internal = conv(1700000000);
    expect(internal.timestamp).toBe(1700000000);
    expect(internal.businessDay).toBeUndefined();
    expect(b.cacheKey(internal)).toBe(1700000000 * 1000);
  });

  test('business-day batch converter retains businessDay; cacheKey = UTC-midnight ms', () => {
    const b = timeBehavior();
    const conv = b.toInternal([{ year: 2024, month: 3, day: 15 }]);
    const internal = conv({ year: 2024, month: 3, day: 15 });
    expect(internal.timestamp).toBe(ts(2024, 3, 15));
    expect(internal.businessDay).toEqual({ year: 2024, month: 3, day: 15 });
    expect(b.cacheKey(internal)).toBe(Date.UTC(2024, 2, 15));
  });

  test('string batch converter parses to a business day', () => {
    const b = timeBehavior();
    const conv = b.toInternal(['2024-03-15', '2024-03-16']);
    const internal = conv('2024-03-15');
    expect(internal.timestamp).toBe(ts(2024, 3, 15));
    expect(internal.businessDay).toEqual({ year: 2024, month: 3, day: 15 });
  });

  test('does not mutate the user item object', () => {
    const b = timeBehavior();
    const userItem = { year: 2024, month: 3, day: 15 };
    const conv = b.toInternal([userItem]);
    const internal = conv(userItem);
    expect(internal.businessDay).not.toBe(userItem); // a fresh object, not the user's
    expect(userItem).toEqual({ year: 2024, month: 3, day: 15 }); // untouched
  });
});

describe('timeBehavior — fillWeights (study 03 §2 bands)', () => {
  const mk = (timestamps: number[]) => {
    const b = timeBehavior();
    const points = timestamps.map((t) => ({
      item: { timestamp: t } as TimeInternal,
      key: t as unknown as HorzKey,
      weight: 0,
    }));
    return { b, points };
  };

  test('day-boundary series get weight Day=50, month/year starts higher', () => {
    // 2023-12-30, 2023-12-31, 2024-01-01 (year change), 2024-01-02
    const { b, points } = mk([ts(2023, 12, 30), ts(2023, 12, 31), ts(2024, 1, 1), ts(2024, 1, 2)]);
    b.fillWeights(points, 0);
    // points[1]: day changed → 50
    expect(points[1].weight).toBe(50);
    // points[2]: year changed → 70
    expect(points[2].weight).toBe(70);
    // points[3]: day changed → 50
    expect(points[3].weight).toBe(50);
  });

  test('month change → 60', () => {
    const { b, points } = mk([ts(2024, 1, 31), ts(2024, 2, 1)]);
    b.fillWeights(points, 0);
    expect(points[1].weight).toBe(60);
  });

  test('intraday divisor bands: hour1=30, minute1=20, second=10, sub-second=0', () => {
    const base = ts(2024, 3, 15, 10, 0, 0);
    const { b, points } = mk([
      base, // 10:00:00
      base + 3600, // 11:00:00 → hour1 boundary = 30
      base + 3600 + 60, // 11:01:00 → minute1 = 20
      base + 3600 + 60 + 1, // 11:01:01 → second = 10
    ]);
    b.fillWeights(points, 0);
    expect(points[1].weight).toBe(30);
    expect(points[2].weight).toBe(20);
    expect(points[3].weight).toBe(10);
  });

  test('minute5=21, minute30=22, hour3=31, hour6=32, hour12=33', () => {
    const base = ts(2024, 3, 15, 0, 0, 0);
    const cases: Array<[number, number]> = [
      [base + 5 * 60, 21], // 00:05 vs 00:00 → 5-min bucket changed
      [base + 30 * 60, 22], // 00:30 → 30-min bucket
      [base + 3 * 3600, 31], // 03:00 → 3h bucket
      [base + 6 * 3600, 32], // 06:00 → 6h bucket
      [base + 12 * 3600, 33], // 12:00 → 12h bucket
    ];
    for (const [t, expected] of cases) {
      const { b, points } = mk([base, t]);
      b.fillWeights(points, 0);
      expect(points[1].weight).toBe(expected);
    }
  });

  test('first point gets an average-gap guess when N>1; stays 0 with a single point', () => {
    const { b, points } = mk([ts(2024, 3, 15), ts(2024, 3, 16), ts(2024, 3, 17)]);
    b.fillWeights(points, 0);
    // avg gap = 1 day; fake previous one day back → day changed → 50
    expect(points[0].weight).toBe(50);

    const single = mk([ts(2024, 3, 15)]);
    single.b.fillWeights(single.points, 0);
    expect(single.points[0].weight).toBe(0);
  });

  test('incremental fill from startIndex leaves the prefix untouched', () => {
    const { b, points } = mk([ts(2024, 3, 15), ts(2024, 3, 16), ts(2024, 3, 17, 1)]);
    points[0].weight = 999;
    points[1].weight = 888;
    b.fillWeights(points, 2);
    expect(points[0].weight).toBe(999);
    expect(points[1].weight).toBe(888);
    // points[2] only an hour after a day boundary? day is same (16 vs 17) → day change 50
    expect(points[2].weight).toBe(50);
  });
});

describe('timeBehavior — maxTickWeight', () => {
  test('returns the max weight', () => {
    const b = timeBehavior();
    expect(b.maxTickWeight([20, 50, 30])).toBe(50);
  });

  test('a max strictly between Hour1(30) and Day(50) is reduced to Hour1', () => {
    const b = timeBehavior();
    expect(b.maxTickWeight([31, 32, 33])).toBe(30); // study 03 §4.13 quirk
  });
});

describe('timeBehavior — formatItem (crosshair label)', () => {
  test('date only by default (timeVisible off), via dateFormat', () => {
    const b = timeBehavior();
    const conv = b.toInternal([ts(2024, 3, 5)]);
    const internal = conv(ts(2024, 3, 5));
    expect(b.formatItem(internal, loc(), fmtOpts())).toBe("05 Mar '24");
  });

  test('timeVisible adds a time part; secondsVisible toggles seconds', () => {
    const b = timeBehavior();
    const conv = b.toInternal([ts(2024, 3, 5, 14, 30, 45)]);
    const internal = conv(ts(2024, 3, 5, 14, 30, 45));
    expect(b.formatItem(internal, loc(), fmtOpts({ timeVisible: true, secondsVisible: true }))).toContain(
      '14:30:45',
    );
    const noSec = b.formatItem(internal, loc(), fmtOpts({ timeVisible: true, secondsVisible: false }));
    expect(noSec).toContain('14:30');
    expect(noSec).not.toContain(':45');
  });

  test('localization.timeFormatter wins, receiving the original user time', () => {
    const b = timeBehavior();
    const conv = b.toInternal([{ year: 2024, month: 3, day: 5 }]);
    const internal = conv({ year: 2024, month: 3, day: 5 });
    const out = b.formatItem(
      internal,
      loc({ timeFormatter: (t) => `BD:${JSON.stringify(t)}` }),
      fmtOpts(),
    );
    expect(out).toBe('BD:{"year":2024,"month":3,"day":5}');
  });
});

describe('timeBehavior — formatTick (axis label)', () => {
  test('weight 70 → year; 60 → month; 50 → day-of-month', () => {
    const b = timeBehavior();
    const conv = b.toInternal([ts(2024, 3, 5)]);
    const internal = conv(ts(2024, 3, 5));
    expect(b.formatTick(internal, 70, loc(), fmtOpts())).toBe('2024');
    expect(b.formatTick(internal, 60, loc(), fmtOpts())).toBe('Mar');
    expect(b.formatTick(internal, 50, loc(), fmtOpts())).toBe('5');
  });

  test('intraday weight → time when timeVisible, else day-of-month', () => {
    const b = timeBehavior();
    const conv = b.toInternal([ts(2024, 3, 5, 14, 30, 0)]);
    const internal = conv(ts(2024, 3, 5, 14, 30, 0));
    expect(b.formatTick(internal, 20, loc(), fmtOpts({ timeVisible: true }))).toBe('14:30');
    expect(b.formatTick(internal, 20, loc(), fmtOpts({ timeVisible: false }))).toBe('5');
  });

  test('user tickMarkFormatter wins; null falls back to default', () => {
    const b = timeBehavior();
    const conv = b.toInternal([ts(2024, 3, 5)]);
    const internal = conv(ts(2024, 3, 5));
    const calls: TickMarkType[] = [];
    const fmt = fmtOpts({
      tickMarkFormatter: (_time, type) => {
        calls.push(type);
        return type === TickMarkType.Year ? 'YYY' : null;
      },
    });
    expect(b.formatTick(internal, 70, loc(), fmt)).toBe('YYY');
    expect(b.formatTick(internal, 60, loc(), fmt)).toBe('Mar'); // null → fallback
    expect(calls).toContain(TickMarkType.Year);
    expect(calls).toContain(TickMarkType.Month);
  });

  test('tickMarkFormatter receives the original user time (business day)', () => {
    const b = timeBehavior();
    const conv = b.toInternal([{ year: 2024, month: 3, day: 5 }]);
    const internal = conv({ year: 2024, month: 3, day: 5 });
    let seen: unknown;
    b.formatTick(
      internal,
      70,
      loc(),
      fmtOpts({
        tickMarkFormatter: (time) => {
          seen = time;
          return 'x';
        },
      }),
    );
    expect(seen).toEqual({ year: 2024, month: 3, day: 5 });
  });
});

describe('timeBehavior — augmentDefaults', () => {
  test('sets localization.dateFormat = DEFAULT_DATE_FORMAT and touches nothing else of substance', () => {
    const b = timeBehavior();
    const defaults: HorzScaleOptionGroups = {
      timeScale: {
        rightOffset: 0,
        rightOffsetPixels: undefined,
        barSpacing: 6,
        minBarSpacing: 0.5,
        maxBarSpacing: 0,
        fixLeftEdge: false,
        fixRightEdge: false,
        resizeAnchor: 'right-offset',
        rightBarStaysOnScroll: false,
        borderVisible: true,
        borderColor: '#2B2B43',
        visible: true,
        timeVisible: false,
        secondsVisible: true,
        shiftVisibleRangeOnNewBar: true,
        allowShiftVisibleRangeOnWhitespaceReplacement: false,
        ticksVisible: false,
        uniformDistribution: false,
        tickMarkMaxCharacterLength: undefined,
        minimumHeight: 0,
        allowBoldLabels: true,
        tickMarkFormatter: undefined,
      },
      localization: {
        locale: 'en-US',
        dateFormat: 'WRONG',
        priceFormatter: undefined,
        percentageFormatter: undefined,
        timeFormatter: undefined,
      },
    };
    const beforeTs = { ...defaults.timeScale };
    b.augmentDefaults(defaults);
    expect(defaults.localization.dateFormat).toBe(DEFAULT_DATE_FORMAT);
    // time-scale group is otherwise untouched
    expect(defaults.timeScale).toEqual(beforeTs);
  });
});

describe('timeBehavior — timezoneOffset', () => {
  test('absent by default (dead-cheap when not configured)', () => {
    const b = timeBehavior();
    expect(b.timezoneOffset).toBeUndefined();
  });
});
