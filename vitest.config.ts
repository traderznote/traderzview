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
    environment: 'node',
    passWithNoTests: true,
  },
});
