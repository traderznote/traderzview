// Typed deltas emitted by the data layer (architecture §4.5 item 2). Series views
// patch their geometry per diff kind instead of rebuilding, so the reference's
// "time scale changed → re-send every series' full array" path is designed out.
import type { TimeIndex } from '../core';

export type StoreDiff =
  | { kind: 'replace' } // full reload (setData)
  | { kind: 'append'; count: number }
  | { kind: 'updateLast' }
  | { kind: 'reindex'; fromSlot: TimeIndex } // timeline shifted under the series
  | { kind: 'insert'; atSlot: TimeIndex };

export interface TimelineDiff {
  firstChanged: TimeIndex | null;
  baseIndex: TimeIndex | null;
}
