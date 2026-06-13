import { defineConfig } from '@playwright/test';

// Browser scenes and the backend-conformance suite live under bench/ and activate
// at M6 / M10. Pinned headless Chromium + 4x CDP CPU throttling is the normative
// measurement methodology (perf §4.3); the throttle helper is bench/browser/throttle.ts.
export default defineConfig({
  testDir: 'bench/browser',
  fullyParallel: false,
  forbidOnly: true,
  reporter: 'list',
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
