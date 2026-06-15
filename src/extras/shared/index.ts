// traderzview · extras/shared — re-export point for the helpers the four first-party
// plugins consume. The §12.4 adapter convention lives here; gfx crisp/shape helpers are
// used directly from `../../gfx` (NOT re-wrapped). Public seams only (arch §3.1).
export { createPrimitiveAdapter } from './adapter';
export type { PrimitiveAdapter, PrimitiveAdapterInit, PrimitiveTarget } from './adapter';
