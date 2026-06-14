// The library-global error sink (architecture §4.1). A throwing event listener
// does not abort dispatch — its error is handed here instead. The default
// rethrows on a microtask so the failure surfaces without truncating the round;
// hosts may install their own reporter.

export type ReportError = (error: unknown) => void;

const defaultReporter: ReportError = (error) => {
  queueMicrotask(() => {
    throw error;
  });
};

let reporter: ReportError = defaultReporter;

/** Hand an error to the active reporter (never throws synchronously by default). */
export function reportError(error: unknown): void {
  reporter(error);
}

/** Install a reporter; pass `null` to restore the default microtask-rethrow. */
export function setReportError(fn: ReportError | null): void {
  reporter = fn ?? defaultReporter;
}
