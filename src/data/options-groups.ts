// Horizontal-scale option groups (architecture §4.5.5). These types are declared
// HERE, in `data`, next to IHorzScaleBehavior — so a behavior's augmentDefaults
// hook is typed (`HorzScaleOptionGroups`) without `data` ever importing `model`.
// `model` re-exports them for layer-2 of the §4.3 defaults pipeline (model → data
// is a legal import). Field-level shapes are design 02 §6.5 / §6.7 / §13.3.

/**
 * Weight → tick-mark category, used by the time behavior to pick the Intl/format
 * style for a tick label (study 03 §4.13). design 03 sketches this as an `enum`;
 * the M0-locked erasableSyntaxOnly flag forbids enums, so this is the erasable
 * const-object + union equivalent — identical `TickMarkType.Year` member access,
 * zero runtime enum (the exact pattern src/gfx/commands.ts uses for LineStyle).
 */
export const TickMarkType = {
  Year: 0,
  Month: 1,
  DayOfMonth: 2,
  Time: 3,
  TimeWithSeconds: 4,
} as const;
export type TickMarkType = (typeof TickMarkType)[keyof typeof TickMarkType];

/**
 * The user `tickMarkFormatter` (design 02 §6.5): `null` falls back to the default
 * formatter. `H` is the user time form (its `originalTime`).
 */
export type TickMarkFormatter<H> = (time: H, type: TickMarkType, locale: string) => string | null;

/** Time-scale options (design 02 §6.5). Defaults are the §6.5 table. */
export interface TimeScaleOptions<H = unknown> {
  rightOffset: number;
  rightOffsetPixels: number | undefined;
  barSpacing: number;
  minBarSpacing: number;
  maxBarSpacing: number; // 0 = no max
  fixLeftEdge: boolean;
  fixRightEdge: boolean;
  resizeAnchor: 'right-offset' | 'visible-range';
  rightBarStaysOnScroll: boolean;
  borderVisible: boolean;
  borderColor: string;
  visible: boolean;
  timeVisible: boolean;
  secondsVisible: boolean;
  shiftVisibleRangeOnNewBar: boolean;
  allowShiftVisibleRangeOnWhitespaceReplacement: boolean;
  ticksVisible: boolean;
  uniformDistribution: boolean;
  tickMarkMaxCharacterLength: number | undefined; // undefined → 8
  minimumHeight: number;
  allowBoldLabels: boolean;
  tickMarkFormatter: TickMarkFormatter<H> | undefined; // time-behavior augmentation
}

/** Localization options (design 02 §6.7). `H` is the user time form. */
export interface LocalizationOptions<H = unknown> {
  locale: string;
  dateFormat: string; // time-behavior augmentation → DEFAULT_DATE_FORMAT
  priceFormatter: ((price: number) => string) | undefined;
  percentageFormatter: ((pct: number) => string) | undefined;
  timeFormatter: ((time: H) => string) | undefined; // crosshair label
}

/**
 * The exactly-two option groups a behavior may augment in the §4.3 defaults
 * pipeline (design 02 §13.3). Mutated in place on a cloned strict-defaults object;
 * nothing else is reachable from a behavior.
 */
export interface HorzScaleOptionGroups<H = unknown> {
  timeScale: TimeScaleOptions<H>;
  localization: LocalizationOptions<H>;
}

/** The formatting flags formatItem/formatTick receive as arguments (design 02 §13.3). */
export type TimeScaleFormatOptions<H = unknown> = Pick<
  TimeScaleOptions<H>,
  'timeVisible' | 'secondsVisible' | 'tickMarkFormatter'
>;
