// Model shared surface (architecture §4.6 "shared" row, §4.5.5, §6 / §9.3).
// This file holds the model's small cross-cutting glue:
//   • pane-id minting (`'p0','p1',…` — never reused; the policy lives in
//     pane-manager.ts, the formatter here);
//   • brand re-exports the model surface needs (PaneId is a model id);
//   • the option-group types RE-EXPORTED from `data` (architecture §4.5.5 — they
//     are declared in `data` next to IHorzScaleBehavior so a behavior's
//     augmentDefaults is typed without `data` importing `model`; `model → data`
//     is a legal import, so the re-export is the model-side seam);
//   • the library defaults tables (layer 1 of the §4.3 three-layer pipeline);
//   • the builders that produce the `HorzGeometry` value object and the
//     `PriceConverter` function-bag that VIEWS consume (architecture §6 / §9.3
//     "geometry as values") — the model builds plain values, never handing views
//     a model object.
//
// HARD walls (architecture §3.1): imports only core / fmt / data / sibling model.
import type { Brand } from '../core';
import {
  PriceScaleMode,
  defaultLogFormula,
  toLog,
  type LogFormula,
  type MinMax,
} from './price-scale/modes';
import { createPriceGeometry } from './price-scale/geometry';
import { createHorzGeometry, type HorzGeometry, type HorzGeometryParams } from './time-scale/geometry';

// --- ids + brand re-exports ------------------------------------------------------

/** A chart-unique, never-reused pane identity (`'p0','p1',…`; design 02 §11). */
export type PaneId = Brand<string, 'PaneId'>;

/** Mint the id string for the `n`-th pane ever created (creation-order counter,
 *  NOT the positional index — the counter never decrements). The never-reuse
 *  invariant is enforced by pane-manager.ts holding a monotonic counter. */
export function formatPaneId(creationOrdinal: number): PaneId {
  return `p${creationOrdinal}` as PaneId;
}

// --- option-group re-exports from `data` (architecture §4.5.5) -------------------

export type {
  TimeScaleOptions,
  LocalizationOptions,
  HorzScaleOptionGroups,
} from '../data';

// --- library defaults tables (layer 1 of the §4.3 defaults pipeline) -------------

/** Top-level chart options the ChartModel owns (design 02 §6.1). Interactive
 *  state (barSpacing after a pan, etc.) is NOT here — that is model state (§5.5). */
export interface ChartOptions {
  width: number;
  height: number;
  autoSize: boolean;
  validation: 'throw' | 'warn' | 'off';
  addDefaultPane: boolean;
  hoveredSeriesOnTop: boolean;
  defaultPriceScaleId: string;
  layout: LayoutOptions;
  grid: GridOptions;
  crosshair: CrosshairOptions;
}

/** Layout options subset the model needs (design 02 §6.2). */
export interface LayoutOptions {
  background: { type: 'solid'; color: string };
  textColor: string;
  fontSize: number;
  fontFamily: string;
}

/** Grid options (design 02 §6.3). */
export interface GridOptions {
  vertLines: { color: string; visible: boolean };
  horzLines: { color: string; visible: boolean };
}

/** Crosshair options the model owns the mode of (design 02 §6.4). */
export interface CrosshairOptions {
  mode: 'normal' | 'magnet' | 'hidden' | 'magnet-ohlc';
}

/** Price-scale options the model owns (design 02 §6.6). */
export interface PriceScaleOptions {
  autoScale: boolean;
  mode: PriceScaleMode;
  invertScale: boolean;
  borderVisible: boolean;
  borderColor: string;
  entireTextOnly: boolean;
  visible: boolean;
  ticksVisible: boolean;
  scaleMargins: { top: number; bottom: number };
  minimumWidth: number;
  tickMarkDensity: number;
}

const DEFAULT_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";

/** Library chart-option defaults (design 02 §6.1–§6.4). */
export const DEFAULT_CHART_OPTIONS: ChartOptions = {
  width: 0,
  height: 0,
  autoSize: false,
  validation: 'throw',
  addDefaultPane: true,
  hoveredSeriesOnTop: true,
  defaultPriceScaleId: 'right',
  layout: {
    background: { type: 'solid', color: '#FFFFFF' },
    textColor: '#191919',
    fontSize: 12,
    fontFamily: DEFAULT_FONT_FAMILY,
  },
  grid: {
    vertLines: { color: '#D6DCDE', visible: true },
    horzLines: { color: '#D6DCDE', visible: true },
  },
  crosshair: { mode: 'magnet' },
};

/** Re-export the `data`-owned time-scale defaults table here as the model's layer-1
 *  source (design 02 §6.5). Frozen against accidental mutation in dev. */
export const DEFAULT_TIME_SCALE_OPTIONS = {
  rightOffset: 0,
  rightOffsetPixels: undefined,
  barSpacing: 6,
  minBarSpacing: 0.5,
  maxBarSpacing: 0,
  fixLeftEdge: false,
  fixRightEdge: false,
  resizeAnchor: 'right-offset' as const,
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
};

function priceScaleDefaults(visible: boolean): PriceScaleOptions {
  return {
    autoScale: true,
    mode: PriceScaleMode.Normal,
    invertScale: false,
    borderVisible: true,
    borderColor: '#2B2B43',
    entireTextOnly: false,
    visible,
    ticksVisible: false,
    scaleMargins: { top: 0.2, bottom: 0.1 },
    minimumWidth: 0,
    tickMarkDensity: 2.5,
  };
}

/** Library price-scale defaults (design 02 §6.6): right visible, left hidden. */
export const DEFAULT_PRICE_SCALE_OPTIONS = {
  right: priceScaleDefaults(true),
  left: priceScaleDefaults(false),
};

// --- value-object builders for views (architecture §6 / §9.3) --------------------

/** Build the immutable `HorzGeometry` value object (architecture §6). A thin pass-
 *  through to `time-scale/geometry.ts`, named here so the shared surface is the one
 *  place the model assembles the geometry-as-values views consume (§9.3). */
export function buildHorzGeometry(p: HorzGeometryParams): HorzGeometry {
  return createHorzGeometry(p);
}

/** The four price-scale modes as their PUBLIC string flags (design 02 §6.6 / arch
 *  §6 `PriceConverter.mode`). The view-facing function-bag carries the string, not
 *  the numeric mode, so views never import `model`'s `PriceScaleMode`. */
export type PriceConverterMode = 'normal' | 'log' | 'percent' | 'indexed';

const MODE_FLAG: Record<PriceScaleMode, PriceConverterMode> = {
  [PriceScaleMode.Normal]: 'normal',
  [PriceScaleMode.Logarithmic]: 'log',
  [PriceScaleMode.Percentage]: 'percent',
  [PriceScaleMode.IndexedTo100]: 'indexed',
};

/** The view-facing price function-bag (architecture §6). Plain functions + numbers
 *  — never a model object — so the re-export to views/extras carries no `model`
 *  type leak while the model still owns the geometry math. */
export interface PriceConverter {
  /** media-px Y; applies the active mode transform (study 06 IMPROVE). */
  priceToCoordinate(price: number): number;
  /** close of the first visible bar; null ⇒ percent/indexed skip (§6). */
  readonly firstValue: number | null;
  /** the mode flag a kind branches on (§6). */
  readonly mode: PriceConverterMode;
  /** price → logical (log/percent/indexed coupling, study 04 §4.4). */
  toLogical(price: number): number;
}

export interface PriceConverterParams {
  /** H: scale height, media px. */
  readonly height: number;
  /** Visible range in the mode's LOGICAL space (null on an empty scale). */
  readonly range: MinMax | null;
  readonly scaleMargins: { readonly top: number; readonly bottom: number };
  readonly marginAbovePx: number;
  readonly marginBelowPx: number;
  readonly mode: PriceScaleMode;
  readonly inverted: boolean;
  /** The series' first value (percent/indexed base; null ⇒ skip). */
  readonly firstValue: number | null;
  /** Active log formula (Log mode only); defaults to {L=4,C=1e−4}. */
  readonly logFormula?: LogFormula;
}

/** Build the `PriceConverter` function-bag one series consumes for a frame
 *  (architecture §6). Backed by `price-scale/geometry.ts`; the bundled `toLogical`
 *  makes the firstValue/percent coupling explicit (study 06 IMPROVE). */
export function buildPriceConverter(p: PriceConverterParams): PriceConverter {
  const logFormula = p.logFormula ?? defaultLogFormula();
  const geom = createPriceGeometry({
    height: p.height,
    range: p.range,
    scaleMargins: p.scaleMargins,
    marginAbovePx: p.marginAbovePx,
    marginBelowPx: p.marginBelowPx,
    mode: p.mode,
    inverted: p.inverted,
    logFormula,
  });
  const isLog = p.mode === PriceScaleMode.Logarithmic;
  return Object.freeze({
    priceToCoordinate: (price: number): number => geom.logicalToCoordinate(price),
    firstValue: p.firstValue,
    mode: MODE_FLAG[p.mode],
    toLogical: (price: number): number => (isLog && price !== 0 ? toLog(price, logFormula) : price),
  });
}
