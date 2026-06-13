// 4x CDP CPU throttle (perf §4.3) — applied at the start of every browser scene so
// CI frame-time budgets are measured on a reproducible, low-end-equivalent target.
// Used by the Playwright scenes that land at M10/M11.
import type { Page } from '@playwright/test';

export async function throttle4x(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
}
