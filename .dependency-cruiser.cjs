'use strict';
// dependency-cruiser config — encodes dev-docs/design/01-architecture.md §3.1
// (the allowed-import table) and §3.2 (no cycles; import a module only through
// its index.ts). `pnpm run verify` fails on any violation. This is the second
// layer wall, complementing the TypeScript project references in tsconfig.*.

/** @type {Record<string, string[]>} architecture §3.1 — allowed cross-module imports */
const ALLOWED = {
  core: [],
  fmt: ['core'],
  gfx: ['core'],
  data: ['core', 'fmt'],
  model: ['core', 'fmt', 'data'],
  views: ['core', 'fmt', 'data', 'model', 'gfx'],
  'backend-canvas': ['core', 'gfx'],
  host: ['core', 'fmt', 'gfx', 'data', 'model', 'views'],
  api: ['core', 'fmt', 'gfx', 'data', 'model', 'views', 'host', 'backend-canvas'],
  extras: ['api', 'gfx', 'core', 'fmt'],
};

const MODULES = Object.keys(ALLOWED);
const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');

const layerRules = MODULES.map((m) => {
  const permitted = new Set([m, ...ALLOWED[m]]);
  const forbidden = MODULES.filter((x) => !permitted.has(x));
  return {
    name: `layer-${m}`,
    comment: `${m} may import only [${ALLOWED[m].join(', ') || 'nothing'}] (architecture §3.1).`,
    severity: 'error',
    from: { path: `^src/${esc(m)}/` },
    to: { path: `^src/(${forbidden.map(esc).join('|')})/` },
  };
});

module.exports = {
  forbidden: [
    ...layerRules,
    {
      name: 'entry-only-api-extras',
      comment: 'src/index.ts may import only api and extras (architecture §3.1).',
      severity: 'error',
      from: { path: '^src/index\\.ts$' },
      to: { path: '^src/', pathNot: ['^src/(api|extras)/', '^src/index\\.ts$'] },
    },
    {
      name: 'no-deep-import',
      comment: 'Import another module only through its index.ts, never a deep file (architecture §3.2).',
      severity: 'error',
      from: { path: '^src/([^/]+)/' },
      to: { path: '^src/[^/]+/', pathNot: ['^src/$1/', 'index\\.ts$'] },
    },
    {
      name: 'no-circular',
      comment: 'No import cycles within or across modules (architecture §3.2).',
      severity: 'error',
      from: {},
      to: { circular: true },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsConfig: { fileName: 'tsconfig.base.json' },
    tsPreCompilationDeps: true,
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.mjs', '.cjs', '.json'] },
  },
};
