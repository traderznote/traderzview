// `conformance` CI job — delegates to the M6 backend-conformance runner
// (bench/conformance/run.mjs), which renders the gfx command-stream fixtures
// through canvasBackend() in a Playwright Chromium page and gates PNG snapshots
// (design 03 §9 / roadmap §13). The runner is itself CI-gated: if Chromium is not
// installed it prints a clear message and exits 0, so this never fails locally.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const runner = join(root, 'bench', 'conformance', 'run.mjs');
const r = spawnSync(process.execPath, [runner], { stdio: 'inherit' });
process.exit(r.status ?? 0);
