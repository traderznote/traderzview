import { defineConfig } from 'vitest/config';

// Unit tests run in the node environment by default (headless modules forbid
// lib.dom). DOM-touching modules (host, backend-canvas, api, extras) opt into
// jsdom per-file via a `// @vitest-environment jsdom` docblock — wired when those
// modules first ship tests (M6+). TDD is mandatory from M1 (roadmap §1.1).
export default defineConfig({
  // Mirror the build-time defines so dev asserts run under test (architecture §3.3).
  define: { __DEV__: 'true', __TV_PROFILE__: 'false' },
  test: {
    include: ['src/**/*.{test,spec}.ts'],
    // The counter-propagation suite needs __TV_PROFILE__ = true (the LIVE guards), so it
    // runs only under vitest.profile.config.ts; exclude it here where the define is false
    // (its first assertion would otherwise fail by design).
    exclude: ['node_modules/**', 'src/api/profiling.test.ts'],
    environment: 'node',
    passWithNoTests: true,
  },
});
