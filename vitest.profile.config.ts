import { defineConfig } from 'vitest/config';

// Profiling-enabled test config (perf §9.6). The default vitest.config.ts defines
// __TV_PROFILE__ = false (mirroring the shipped build), which strips every counter
// guard — so the counter-propagation tests, which must exercise the LIVE guards, run
// under THIS config instead: `vitest run --config vitest.profile.config.ts`. It defines
// __TV_PROFILE__ = true and includes ONLY the profiling test(s).
export default defineConfig({
  define: { __DEV__: 'true', __TV_PROFILE__: 'true' },
  test: {
    include: ['src/api/profiling.test.ts'],
    environment: 'node',
    // The default `threads` pool crashes a worker on this Node/Windows combo; `forks`
    // runs the same suite cleanly (the crash is a tinypool quirk, not a test failure).
    pool: 'forks',
  },
});
