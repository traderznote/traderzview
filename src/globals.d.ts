// Compile-time defines (architecture §3.3 / perf §3.3.1). Substituted as literals
// by esbuild in the published build (scripts/build.mjs: __DEV__=false,
// __TV_PROFILE__=false) and by vite in tests (vitest.config.ts: __DEV__=true), so
// dev asserts and bench counters dead-code-eliminate out of the shipped bundle.
//
// `declare global` (inside a module) injects true ambient globals regardless of
// module detection. Every composite project that uses a define includes this file.
export {};

declare global {
  /** True in dev/test builds; false (and stripped) in the published bundle. */
  const __DEV__: boolean;
  /** True only under bench instrumentation; false (and stripped) otherwise. */
  const __TV_PROFILE__: boolean;

  // Host globals present on every target (browser, Node, workers) but absent from
  // lib.es2022 — declared here so headless modules can use them without lib.dom.
  function queueMicrotask(callback: () => void): void;
}
