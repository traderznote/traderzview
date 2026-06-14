// Public surface of the `fmt` module — formatters and the formatted-label LRU.
// Imported only through this index (architecture §3.1). fmt imports core only.

export type { IPriceFormatter } from './price';
export { precisionByMinMove, priceFormatter, percentFormatter, volumeFormatter } from './price';
export { DEFAULT_DATE_FORMAT, formatDate, formatTime } from './date';
export { FormattedLabelsCache } from './labels-cache';
