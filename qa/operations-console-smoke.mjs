import { chromium } from '@playwright/test';
import { resolve } from 'node:path';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => {
  try {
    localStorage.setItem('axiom-ui-language-v1', 'zh-CN');
  } catch {
    // Sandboxed previews intentionally cannot access origin storage.
  }
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(error.message));

try {
  await page.goto(baseUrl, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: '运行观测' }).click();
  const consoleView = page.locator('.ops-console');
  await consoleView.waitFor({ state: 'visible', timeout: 20_000 });
  await page.waitForTimeout(400);
  const snapshotResponse = await page.waitForResponse((response) => response.url().includes('/api/runtime/operations'), { timeout: 5_000 }).catch(() => null);
  const range = page.locator('.ops-range button');
  const initialRangeCount = await range.count();
  await range.nth(2).click();
  await page.waitForTimeout(250);
  const activeRange = await page.locator('.ops-range button.active').innerText();
  const assertions = {
    consoleVisible: await consoleView.isVisible(),
    durableSnapshotLoaded: Boolean(snapshotResponse) || await page.locator('.ops-kpi').count() === 4,
    hasQueuePanel: await page.getByText('队列与租约', { exact: true }).count() === 1,
    hasModelPanel: await page.getByText('模型表现', { exact: true }).count() === 1,
    hasSlaPanel: await page.getByText('SLA 概览', { exact: true }).count() === 1,
    hasContextSummaryPanel: await page.getByText('长对话整理', { exact: true }).count() === 1,
    rangeChoicesVisible: initialRangeCount === 3,
    rangeSwitchWorks: activeRange === '7 天',
    noHorizontalOverflow: await page.evaluate(() => document.body.scrollWidth <= window.innerWidth + 1),
    noBrowserErrors: consoleErrors.length === 0,
  };
  await page.screenshot({ path: resolve(process.cwd(), 'qa', 'operations-console.png'), fullPage: false });
  process.stdout.write(`${JSON.stringify({ assertions, consoleErrors }, null, 2)}\n`);
  if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
} finally {
  await browser.close();
}
