import { chromium } from '@playwright/test';

const baseUrl = (process.env.QA_URL ?? 'http://127.0.0.1:4300').replace(/\/$/, '');
const tenant = `qa-i18n-${Date.now()}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  extraHTTPHeaders: { 'x-axiom-tenant-id': tenant, 'x-axiom-user-id': tenant },
});
await context.addInitScript(() => {
  try {
    localStorage.removeItem('axiom-ui-language-v1');
    localStorage.setItem('axiom-onboarding-seen-v2', '1');
  } catch {
    // Sandboxed previews intentionally cannot access origin storage.
  }
});
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text());
});

const visibleChinese = async () => page.evaluate(() => {
  const ignored = 'pre,code,script,style,[data-i18n-ignore="true"],.dash-chat-markdown,.dash-chat-artifact-markdown,.task-evidence-claim p,.dash-plugin-preview-frame';
  const values = new Set();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  while (node) {
    const parent = node.parentElement;
    const text = node.nodeValue?.replace(/\s+/g, ' ').trim() ?? '';
    if (parent && text && /[\u3400-\u9fff]/u.test(text) && !parent.closest(ignored)) {
      const style = getComputedStyle(parent);
      const rect = parent.getBoundingClientRect();
      if (style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0) values.add(text);
    }
    node = walker.nextNode();
  }
  for (const element of document.querySelectorAll('[aria-label],[title],[placeholder]')) {
    if (element.closest(ignored)) continue;
    for (const attribute of ['aria-label', 'title', 'placeholder']) {
      const text = element.getAttribute(attribute)?.trim() ?? '';
      if (/[\u3400-\u9fff]/u.test(text)) values.add(`${attribute}: ${text}`);
    }
  }
  return [...values];
});

await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.waitForSelector('.axiom-dashboard');
if (await page.locator('html').getAttribute('lang') !== 'en') throw new Error('A fresh profile did not default to English.');
if ((await page.locator('.dash-brand').innerText()).includes('任务台')) throw new Error('The default task desk label is still Chinese.');

const navButtons = [
  ['tasks', 2],
  ['chat', 3],
  ['projects', 4],
  ['templates', 5],
  ['workflows', 6],
  ['schedules', 7],
  ['agent-studio', 8],
  ['operations', 9],
  ['plugins', 1],
];
const untranslated = new Map();
for (const [name, index] of navButtons) {
  await page.locator('.dash-nav-rail button').nth(index).click();
  await page.waitForTimeout(250);
  const values = await visibleChinese();
  if (values.length) untranslated.set(name, values);
}
await page.locator('button[title="Production readiness"]').click();
await page.waitForSelector('.readiness-panel');
const readinessCopy = await visibleChinese();
if (readinessCopy.length) untranslated.set('readiness', readinessCopy);
await page.locator('button[aria-label="Close system status"]').click();

await page.locator('button[title="Runtime settings"]').click();
await page.waitForSelector('.settings-panel');
const settingsCopy = await visibleChinese();
if (settingsCopy.length) untranslated.set('settings', settingsCopy);
await page.locator('button[aria-label="Close settings"]').click();

await page.locator('button[title="Notifications"]').click();
await page.waitForTimeout(150);
const notificationCopy = await visibleChinese();
if (notificationCopy.length) untranslated.set('notifications', notificationCopy);
await page.keyboard.press('Escape');
if (untranslated.size) {
  throw new Error(`Visible untranslated UI copy:\n${[...untranslated].map(([name, values]) => `${name}: ${values.join(' | ')}`).join('\n')}`);
}

await page.locator('.language-trigger').click();
await page.locator('.language-popover button[lang="zh-CN"]').click();
await page.waitForFunction(() => document.documentElement.lang === 'zh-CN');
if (!(await page.locator('.dash-nav-rail').innerText()).includes('任务管理')) throw new Error('Chinese UI selection did not apply.');
await page.reload({ waitUntil: 'networkidle' });
if (await page.locator('html').getAttribute('lang') !== 'zh-CN') throw new Error('Chinese UI selection was not persisted.');

await page.locator('.language-trigger').click();
await page.locator('.language-popover button[lang="en"]').click();
await page.waitForFunction(() => document.documentElement.lang === 'en');
if (!(await page.locator('.dash-nav-rail').innerText()).includes('Tasks')) throw new Error('English UI selection did not reapply.');
if (consoleErrors.length) throw new Error(`Browser console errors: ${consoleErrors.join(' | ')}`);

console.log(JSON.stringify({ status: 'passed', defaultLanguage: 'en', persistedLanguage: 'zh-CN', workspaces: navButtons.map(([name]) => name) }, null, 2));
await browser.close();
