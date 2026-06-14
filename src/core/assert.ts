// Dev-only invariant check (architecture §9 — "expensive validation is dev-only").
// The __DEV__ define is false in the published build, so esbuild eliminates the
// guard and any argument expressions at the call site. Use for internal invariants,
// never for user-input validation (that stays always-on — data §4.5.4 / validation).
export function assert(condition: unknown, message: string): asserts condition {
  if (__DEV__ && !condition) {
    throw new Error(`Assertion failed: ${message}`);
  }
}
