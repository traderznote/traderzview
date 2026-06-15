// traderzview · api — the single error taxonomy (spec 02 §16). Every
// library-raised contract violation is a ChartError carrying a code discriminant;
// malformed numeric input throws RangeError instead (§16 convention 2). The codes
// enumerate every specified throw site — no reserved/dead codes (§16).
import { assert } from '../core';

// erasable const-object (enum forbidden by erasableSyntaxOnly). The value lists
// every code for internal use; the same-named type is the public discriminant.
export const ChartErrorCode = {
  ContainerNotFound: 'container-not-found',
  Disposed: 'disposed',
  InvalidDataOrder: 'invalid-data-order',
  NonFiniteValue: 'non-finite-value',
  ValueOutOfBounds: 'value-out-of-bounds',
  MixedTimeKinds: 'mixed-time-kinds',
  InvalidDateString: 'invalid-date-string',
  StaleUpdate: 'stale-update',
  UnknownSeriesDefinition: 'unknown-series-definition',
  NoSuchScale: 'no-such-scale',
} as const;
export type ChartErrorCode = (typeof ChartErrorCode)[keyof typeof ChartErrorCode];

/** Library-raised error with a `code` discriminant (§16). `instanceof Error` and
    `instanceof ChartError` both hold; the code is the stable, message-independent
    contract surface application code branches on. */
export class ChartError extends Error {
  readonly code: ChartErrorCode;
  constructor(code: ChartErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ChartError';
    this.code = code;
    // Restore the prototype chain across the Error super-call (down-level targets).
    Object.setPrototypeOf(this, ChartError.prototype);
  }
}

/** Throw a ChartError. `detail` is appended to the code in the message so the
    thrown error carries the offending id/index/keys (§3.1 container id, §15.2
    item index + keys) while `.code` stays the clean discriminant. */
export function throwChartError(code: ChartErrorCode, detail?: string): never {
  if (__DEV__) {
    assert(typeof code === 'string', 'throwChartError: code must be a ChartErrorCode');
  }
  throw new ChartError(code, detail === undefined ? code : `${code}: ${detail}`);
}
