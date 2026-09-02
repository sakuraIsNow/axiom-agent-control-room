import { chromium } from '@playwright/test';
import { PNG } from 'pngjs';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const baseUrl = process.env.QA_URL ?? 'http://127.0.0.1:4300';
// Isolate every run so persisted sessions from an earlier visual check cannot
// change graph restoration or task grouping assertions.
const qaTenant = `qa-visual-${Date.now()}`;
const qaHeaders = { 'x-axiom-tenant-id': qaTenant, 'x-axiom-user-id': qaTenant };
const outputDir = resolve(process.cwd(), 'qa');
await mkdir(outputDir, { recursive: true });

const pixelStats = (buffer) => {
  const png = PNG.sync.read(buffer);
  const colors = new Set(); let luminance = 0; let samples = 0;
  for (let index = 0; index < png.data.length; index += 16) {
    const alpha = png.data[index + 3]; if (!alpha) continue;
    const red = png.data[index]; const green = png.data[index + 1]; const blue = png.data[index + 2];
    luminance += red * 0.2126 + green * 0.7152 + blue * 0.0722; samples += 1; colors.add(`${red >> 4}-${green >> 4}-${blue >> 4}`);
  }
  return { averageLuminance: Number((luminance / Math.max(1, samples)).toFixed(2)), quantizedColors: colors.size, sampledPixels: samples };
};
const changedPixels = (first, second) => {
  const a = PNG.sync.read(first); const b = PNG.sync.read(second); let changed = 0;
  for (let index = 0; index < Math.min(a.data.length, b.data.length); index += 4) {
    const difference = Math.abs(a.data[index] - b.data[index]) + Math.abs(a.data[index + 1] - b.data[index + 1]) + Math.abs(a.data[index + 2] - b.data[index + 2]);
    if (difference > 18) changed += 1;
  }
  return changed;
};

const layout = async (page) => page.evaluate(() => {
  const board = document.querySelector('.dash-task-board')?.getBoundingClientRect();
  const orbit = document.querySelector('.dash-orbit-stage, .dash-carousel-empty')?.getBoundingClientRect();
  return {
    bodyScrollWidth: document.body.scrollWidth,
    viewportWidth: innerWidth,
    viewportHeight: innerHeight,
    dashboard: Boolean(document.querySelector('.axiom-dashboard')),
    legacyShell: Boolean(document.querySelector('.axiom-shell')),
    chat: Boolean(document.querySelector('.dash-chat-workspace')),
    timeline: Boolean(document.querySelector('.dash-timeline')),
    taskBoardWidth: board?.width ?? 0,
    taskOrbitWidth: orbit?.width ?? 0,
  };
});

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: qaHeaders });
const page = await context.newPage();
const consoleErrors = [];
let nativeDialogOpened = false;
let qaTaskId = null;
let qaSessionId = null;
let qaPluginId = null;
let qaWorkflowId = null;
let qaScheduleId = null;
let qaArtifactSessionId = null;
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => consoleErrors.push(error.message));
page.on('dialog', (dialog) => { nativeDialogOpened = true; void dialog.dismiss(); });
page.on('response', (response) => {
  if (response.request().method() !== 'POST' || !response.url().endsWith('/api/tasks')) return;
  void response.json().then((body) => {
    if (typeof body?.task?.id === 'string') qaTaskId = body.task.id;
  }).catch(() => undefined);
});

try {
const fixtureStamp = Date.now();
const fixturePluginName = `视觉验收插件-${fixtureStamp}`;
const pluginFixtureResponse = await fetch(`${baseUrl}/api/plugins`, {
  method: 'POST',
  headers: { ...qaHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: fixturePluginName,
    description: '用于验证材质图标、Agent 设计区和独占运行窗口',
    kind: 'mini-app',
    visibility: 'private',
    definition: {
      mode: 'build',
      htmlContent: '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><style>html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#08110d;color:#e8fff1;font:16px system-ui}.app{padding:32px;border:1px solid #2bea78;border-radius:12px;background:#ffffff0d}</style></head><body><main class="app"><strong>Mini App 运行正常</strong></main></body></html>',
      width: 640,
      height: 480,
      toolNames: [],
      appearance: { effect: 'prism', hue: 146, seed: 27 },
      agentEnabled: true,
      agentInstructions: '根据插件内请求调用平台语义路由。',
      designConversation: [{ role: 'assistant', content: '空白插件已就绪。', createdAt: new Date().toISOString() }],
    },
  }),
});
if (!pluginFixtureResponse.ok) throw new Error(`视觉 QA 插件 fixture 创建失败 (${pluginFixtureResponse.status})`);
qaPluginId = (await pluginFixtureResponse.json()).plugin?.id ?? null;

// Keep the chat assertion focused on a direct response while using a
// separate, real task fixture for the task board and lifecycle checks.
const taskFixtureResponse = await fetch(`${baseUrl}/api/tasks`, {
  method: 'POST',
  headers: { ...qaHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sessionId: `qa-task-${fixtureStamp}`,
    title: '视觉验收任务',
    input: 'Implement a deterministic API retry helper.',
    mode: 'analyze',
  }),
});
if (!taskFixtureResponse.ok) throw new Error(`视觉 QA 任务 fixture 创建失败 (${taskFixtureResponse.status})`);
qaTaskId = (await taskFixtureResponse.json()).task?.id ?? null;

const scheduleFixtureResponse = await fetch(`${baseUrl}/api/schedules`, {
  method: 'POST',
  headers: { ...qaHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    sessionId: `qa-schedule-${fixtureStamp}`,
    title: '每日 Agent 行业简报',
    input: '搜索最新 Agent 行业动态，整理 5 条摘要并保留来源。',
    mode: 'analyze',
    enabled: true,
    cadence: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
  }),
});
if (!scheduleFixtureResponse.ok) throw new Error(`视觉 QA 日程 fixture 创建失败 (${scheduleFixtureResponse.status})`);
qaScheduleId = (await scheduleFixtureResponse.json()).schedule?.id ?? null;

await page.goto(baseUrl, { waitUntil: 'networkidle' });
await page.locator('.axiom-dashboard').waitFor({ state: 'visible', timeout: 30_000 });
const dashboardShot = await page.screenshot({ path: resolve(outputDir, 'dashboard-default.png'), fullPage: false });
const dashboardPixels = pixelStats(dashboardShot);
const dashboardLayout = await layout(page);
const currentModel = (await page.locator('.dash-header-state strong').textContent())?.trim() ?? '';
const themeTrigger = page.locator('.theme-trigger').first();
await themeTrigger.click();
const themeChoicesVisible = await page.locator('.theme-option').count() === 4;
await page.waitForTimeout(220);
const themePopoverEscapesHeader = await page.locator('.theme-popover').evaluate((popover) => {
  const header = document.querySelector('.dash-header');
  if (!header) return false;
  const popRect = popover.getBoundingClientRect();
  const headerRect = header.getBoundingClientRect();
  const center = document.elementFromPoint(popRect.left + popRect.width / 2, popRect.top + popRect.height / 2);
  return getComputedStyle(header).overflow === 'visible'
    && popRect.bottom > headerRect.bottom
    && Boolean(center?.closest('.theme-popover'));
});
await page.locator('.theme-option[data-theme-id="graphite"]').click();
const themeSwitchWorks = await page.locator('.axiom-dashboard').getAttribute('data-theme') === 'graphite';
const themePersists = await page.evaluate(() => window.localStorage.getItem('axiom-ui-theme-v1') === 'graphite');
await page.locator('.theme-trigger').first().click();
await page.locator('.theme-option[data-theme-id="ivory"]').click();
await page.waitForTimeout(180);
const deepGrayThemeReadable = await page.locator('.axiom-dashboard').evaluate((dashboard) => {
  const style = getComputedStyle(dashboard);
  const parseHex = (value) => {
    const hex = value.trim().replace('#', '');
    if (!/^[\da-f]{6}$/i.test(hex)) return null;
    return [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16));
  };
  const luminance = (rgb) => rgb.reduce((sum, channel, index) => {
    const normalized = channel / 255;
    const linear = normalized <= .03928 ? normalized / 12.92 : ((normalized + .055) / 1.055) ** 2.4;
    return sum + linear * [.2126, .7152, .0722][index];
  }, 0);
  const contrast = (first, second) => {
    const a = luminance(first);
    const b = luminance(second);
    return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
  };
  const background = parseHex(style.getPropertyValue('--dash-bg'));
  const ink = parseHex(style.getPropertyValue('--dash-ink'));
  const muted = parseHex(style.getPropertyValue('--dash-muted'));
  return dashboard.getAttribute('data-theme') === 'ivory'
    && Boolean(background && ink && muted)
    && Math.max(...background) < 64
    && contrast(ink, background) >= 7
    && contrast(muted, background) >= 4.5;
});
await page.screenshot({ path: resolve(outputDir, 'dashboard-theme-deep-gray.png'), fullPage: false });
await page.locator('.theme-trigger').first().click();
await page.locator('.theme-option[data-theme-id="obsidian"]').click();
const dailyProcessVisible = await page.getByText('每日工作进程', { exact: true }).count() === 1;
const today = await page.evaluate(() => {
  const date = new Date();
  return {
    dayLabel: `${date.getMonth() + 1}月${date.getDate()}日`,
    dateKey: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`,
  };
});
const timelineDate = (await page.locator('.dash-timeline-date-controls strong').textContent())?.trim() ?? '';
const tokenEndDate = (await page.locator('.dash-token-trend-foot span').last().textContent())?.trim() ?? '';
const glassSurfaceActive = await page.locator('.dash-stat-card').first().evaluate((element) => {
  const style = getComputedStyle(element);
  return style.backgroundImage.includes('radial-gradient') && style.backdropFilter.includes('blur') && style.borderColor !== 'rgba(0, 0, 0, 0)';
});
const tokenHeadingReadable = await page.locator('.dash-token-trend-heading').evaluate((element) => {
  const title = element.querySelector('span');
  const total = element.querySelector('strong');
  if (!title || !total) return false;
  const titleStyle = getComputedStyle(title);
  const totalStyle = getComputedStyle(total);
  return titleStyle.whiteSpace === 'nowrap' && totalStyle.whiteSpace === 'nowrap' && title.getBoundingClientRect().height <= 22 && total.getBoundingClientRect().height <= 22;
});
const timelineScroll = page.locator('.dash-day-scroll');
const timelineBefore = await timelineScroll.evaluate((element) => ({ top: element.scrollTop, client: element.clientHeight, scroll: element.scrollHeight }));
const timelineVisibleHeight = await page.locator('.dash-timeline').evaluate((element) => element.getBoundingClientRect().height);
let timelineWheelWorks = timelineBefore.scroll <= timelineBefore.client + 1;
if (!timelineWheelWorks) {
  await timelineScroll.hover();
  await page.mouse.wheel(0, 420);
  await page.waitForTimeout(160);
  timelineWheelWorks = await timelineScroll.evaluate((element) => element.scrollTop > 0);
}
await page.locator('.dash-timeline').screenshot({ path: resolve(outputDir, 'dashboard-timeline.png') });

const settingsButton = page.locator('.dash-header-actions button[title="运行设置"]');
await settingsButton.click();
await page.locator('.settings-panel').waitFor({ state: 'visible' });
const settingsText = await page.locator('.settings-panel').innerText();
const modelSections = await page.locator('.settings-section-heading strong').allTextContents();
const settingsOnlyExposeModels = ['文本模型', '视觉模型', '绘图模型', '视频模型'].every((label) => modelSections.includes(label))
  && !/界面主题|执行策略|Token 上限|成本上限|最长分钟|并行节点/u.test(settingsText);
const providerLocationControls = page.locator('.provider-location-control');
const providerLocationChoicesVisible = await providerLocationControls.count() === 4
  && (await providerLocationControls.allTextContents()).every((text) => text.includes('互联网 API') && text.includes('本地服务'));
const textProviderToggle = page.locator('.settings-section').first().locator('.switch-control input');
await textProviderToggle.check({ force: true });
const textProviderLocation = providerLocationControls.first();
await textProviderLocation.getByRole('button', { name: '本地服务', exact: true }).click();
const providerLocationSwitchWorks = await textProviderLocation.getByRole('button', { name: '本地服务', exact: true }).getAttribute('aria-pressed') === 'true';
await textProviderLocation.getByRole('button', { name: '互联网 API', exact: true }).click();
await textProviderToggle.uncheck({ force: true });
const settingsUseDashboardGlass = await page.locator('.settings-panel').evaluate((element) => {
  const style = getComputedStyle(element);
  return style.backgroundImage.includes('radial-gradient') && style.backdropFilter.includes('blur') && style.borderRadius === '8px';
});
await page.screenshot({ path: resolve(outputDir, 'dashboard-settings.png'), fullPage: false });
await page.locator('.settings-panel .icon-button').first().click();

await page.locator('.dash-header-actions button').first().click();
const readinessPanel = page.locator('.readiness-panel');
await readinessPanel.waitFor({ state: 'visible' });
const readinessText = await readinessPanel.innerText();
const readinessUsesChinesePresentation = readinessText.includes('系统运行状态')
  && ['模型服务', '任务记录', '文件与工具', '长期记忆'].every((label) => readinessText.includes(label))
  && !/(?:Runtime readiness|Required production controls|Local execution is available|production blocker|No hard blockers detected|not checked|\bREADY\b|\bDEGRADED\b|\bBLOCKED\b|Durable persistence|API authentication|Signed tenant principal|Text model provider|Image provider|Long-term memory|Sandboxed tool executor)/u.test(readinessText);
const readinessUsesDashboardGlass = await readinessPanel.evaluate((element) => {
  const style = getComputedStyle(element);
  return style.backgroundImage.includes('radial-gradient') && style.backdropFilter.includes('blur') && Number.parseFloat(style.fontSize) >= 16;
});
const readinessTimeRemoved = await readinessPanel.locator('.readiness-time').count() === 0;
await page.screenshot({ path: resolve(outputDir, 'readiness-panel.png'), fullPage: false });
await readinessPanel.locator('.icon-button').first().click();

let pluginListRequests = 0;
const countPluginRequest = (request) => {
  if (new URL(request.url()).pathname === '/api/plugins') pluginListRequests += 1;
};
page.on('request', countPluginRequest);
const pluginResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/plugins', { timeout: 5_000 });
await page.getByRole('button', { name: '插件', exact: true }).click();
await page.locator('.dash-plugin-workspace').waitFor({ state: 'visible' });
await pluginResponse;
await page.waitForTimeout(200);
const pluginsUseWorkspace = await page.locator('.dash-main-plugins').isVisible() && await page.locator('.plugin-panel').count() === 0;
const pluginGalleryUsesMaterialGlyphs = await page.locator('.dash-plugin-gallery').isVisible()
  && await page.locator('.dash-plugin-glyph').count() > 0;
const pluginWorkspaceGlass = await page.locator('.dash-plugin-glyph').first().evaluate((element) => {
  const style = getComputedStyle(element);
  return style.backgroundImage.includes('radial-gradient') && style.backdropFilter.includes('blur');
});
const pluginGlyphHasFourRings = await page.getByRole('button', { name: `打开插件 ${fixturePluginName}`, exact: true }).locator('.dash-plugin-ring').count() === 4;
const pluginNameBelowGlyph = await page.getByText(fixturePluginName, { exact: true }).evaluate((label) => {
  const glyph = label.parentElement?.querySelector('.dash-plugin-glyph')?.getBoundingClientRect();
  const name = label.getBoundingClientRect();
  return Boolean(glyph && name.top >= glyph.bottom);
});
const pluginRefreshButton = page.getByRole('button', { name: '刷新插件', exact: true });
const pluginRefreshSettles = !(await pluginRefreshButton.isDisabled())
  && await pluginRefreshButton.locator('.spin').count() === 0
  && await page.locator('.dash-plugin-error').count() === 0;
const pluginRefreshIsSingleRequest = pluginListRequests === 1;
const leftNavSettingsRemoved = await page.locator('.dash-nav-rail').getByRole('button', { name: '设置', exact: true }).count() === 0;
await page.getByRole('button', { name: 'Agent 创建', exact: true }).click();
const pluginShellCreateVisible = await page.locator('.dash-plugin-shell-create').isVisible()
  && await page.getByRole('button', { name: '创建空白插件', exact: true }).isVisible();
const pluginStyleChoicesAvailable = await page.locator('.dash-plugin-style-picker > div > button').count() === 8
  && await page.getByRole('button', { name: '随机分配', exact: true }).isVisible();
await page.getByRole('button', { name: '关闭创建表单', exact: true }).click();
await page.getByRole('button', { name: `修改插件 ${fixturePluginName}`, exact: true }).click();
const pluginDesignerWorkspaceVisible = await page.locator('.dash-plugin-design-chat').isVisible()
  && await page.locator('.dash-plugin-live-preview').isVisible()
  && await page.locator('.dash-plugin-design-chat textarea').isVisible();
const pluginWindowSizeButton = page.getByRole('button', { name: '窗口大小', exact: true });
const pluginWindowResizeAvailable = await pluginWindowSizeButton.isVisible();
await pluginWindowSizeButton.click();
const pluginWindowSizeEditor = page.locator('.dash-plugin-size-editor');
await pluginWindowSizeEditor.waitFor({ state: 'visible' });
await page.getByLabel('插件窗口宽度', { exact: true }).fill('700');
await page.getByLabel('插件窗口高度', { exact: true }).fill('520');
await page.screenshot({ path: resolve(outputDir, 'dashboard-plugin-size-editor.png'), fullPage: false });
const pluginResizeResponse = page.waitForResponse((response) => response.request().method() === 'PATCH'
  && new URL(response.url()).pathname === `/api/plugins/${qaPluginId}`, { timeout: 5_000 });
await page.getByRole('button', { name: '保存大小', exact: true }).click();
const pluginResizeResult = await pluginResizeResponse;
await pluginWindowSizeEditor.waitFor({ state: 'hidden' });
const pluginWindowResizeSaved = pluginResizeResult.ok()
  && (await page.locator('.dash-plugin-live-preview > header small').textContent())?.trim() === '700 x 520';
await page.screenshot({ path: resolve(outputDir, 'dashboard-plugin-designer.png'), fullPage: false });
await page.getByRole('button', { name: '返回插件', exact: false }).click();
await page.getByRole('button', { name: `打开插件 ${fixturePluginName}`, exact: true }).click();
await page.locator('.mini-app-backdrop').waitFor({ state: 'visible' });
await page.waitForTimeout(260);
const miniAppUsesExclusiveModal = await page.locator('.mini-app-window[aria-modal="true"]').isVisible()
  && await page.locator('.mini-app-backdrop').evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return rect.left === 0 && rect.top === 0 && rect.width >= innerWidth && rect.height >= innerHeight;
  });
const miniAppBackdropUsesGlass = await page.locator('.mini-app-backdrop').evaluate((element) => getComputedStyle(element).backdropFilter.includes('blur'));
const miniAppSandboxIsOpaque = await page.locator('.mini-app-window iframe').evaluate((element) => {
  const sandbox = element.getAttribute('sandbox') ?? '';
  return sandbox.includes('allow-scripts') && !sandbox.includes('allow-same-origin');
});
const resizedMiniAppRect = await page.locator('.mini-app-window').evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return { width: rect.width, height: rect.height };
});
const pluginWindowResizePersists = Math.abs(resizedMiniAppRect.width - 700) <= 3
  && Math.abs(resizedMiniAppRect.height - 520) <= 3;
await page.screenshot({ path: resolve(outputDir, 'dashboard-mini-app.png'), fullPage: false });
await page.getByRole('button', { name: '关闭插件', exact: true }).click();
await page.getByRole('button', { name: `删除插件 ${fixturePluginName}`, exact: true }).click();
const pluginDeleteWarnsIrreversible = await page.locator('.dash-plugin-delete-backdrop').isVisible()
  && (await page.locator('.dash-plugin-delete-backdrop').innerText()).includes('删除后无法恢复');
await page.locator('.dash-plugin-delete-backdrop').getByRole('button', { name: '取消', exact: true }).click();
page.off('request', countPluginRequest);
await page.screenshot({ path: resolve(outputDir, 'dashboard-plugins.png'), fullPage: false });

let templateListRequests = 0;
let templateCatalogRequests = 0;
const countTemplateRequest = (request) => {
  const pathname = new URL(request.url()).pathname;
  if (pathname === '/api/templates') templateListRequests += 1;
  if (pathname === '/api/template-catalog') templateCatalogRequests += 1;
};
page.on('request', countTemplateRequest);
const templateListResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/templates', { timeout: 5_000 });
const templateCatalogResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/template-catalog', { timeout: 5_000 });
await page.getByRole('button', { name: '模板库', exact: true }).click();
await page.locator('.dash-template-workspace').waitFor({ state: 'visible' });
await Promise.all([templateListResponse, templateCatalogResponse]);
await page.waitForTimeout(200);
const templatesUseWorkspace = await page.locator('.dash-main-templates').isVisible()
  && await page.locator('.template-panel').count() === 0
  && await page.locator('.modal-backdrop .template-panel').count() === 0;
const templateWorkspaceGlass = await page.locator('.dash-template-card, .dash-template-empty').first().evaluate((element) => {
  const style = getComputedStyle(element);
  return style.backgroundImage.includes('radial-gradient') && style.backdropFilter.includes('blur') && style.borderRadius === '8px';
});
const templateRefreshButton = page.getByRole('button', { name: '刷新模板', exact: true });
const templateRefreshSettles = !(await templateRefreshButton.isDisabled())
  && await templateRefreshButton.locator('.spin').count() === 0
  && await page.locator('.dash-template-error').count() === 0;
const templateRefreshUsesSingleRequest = templateListRequests === 1 && templateCatalogRequests === 1;
const leftNavToolsRemoved = await page.locator('.dash-nav-rail').getByRole('button', { name: '工具与就绪', exact: true }).count() === 0;
const headerReadinessStillAvailable = await page.locator('.dash-header-actions button[title="生产就绪"]').count() === 1;
page.off('request', countTemplateRequest);
await page.screenshot({ path: resolve(outputDir, 'dashboard-templates.png'), fullPage: false });

await page.route('**/api/schedules/draft', async (route) => {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      source: 'schedule-agent',
      createsSchedule: false,
      draft: {
        title: 'Agent 行业每日简报',
        input: '搜索最新 Agent 行业动态，整理 5 条摘要并保留来源。',
        mode: 'analyze',
        schedule: { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' },
        agentPolicy: 'auto',
        reason: '每次触发时重新由 Router Agent 和调度 Agent 选择所需能力。',
      },
    }),
  });
});
await page.getByRole('button', { name: '日程', exact: true }).click();
await page.locator('.schedule-workspace').waitFor({ state: 'visible' });
const scheduleComposerVisible = await page.locator('.schedule-agent-composer textarea').isVisible();
const scheduleUsesGlass = await page.locator('.schedule-agent-composer').evaluate((element) => {
  const style = getComputedStyle(element);
  return style.backgroundImage.includes('radial-gradient') && style.backdropFilter.includes('blur') && style.borderRadius === '8px';
});
const scheduleFixtureCard = page.locator('.schedule-card').filter({ hasText: '每日 Agent 行业简报' });
await scheduleFixtureCard.waitFor({ state: 'visible', timeout: 5_000 });
await scheduleFixtureCard.getByText('自动编排', { exact: true }).waitFor({ state: 'visible', timeout: 5_000 });
const scheduleFixtureVisible = await scheduleFixtureCard.isVisible()
  && await scheduleFixtureCard.getByText('自动编排', { exact: true }).isVisible();
const scheduleRunControlsVisible = await scheduleFixtureCard.getByRole('button', { name: '立即运行', exact: true }).isVisible()
  && await scheduleFixtureCard.getByRole('button', { name: /运行记录/u }).isVisible();
await page.locator('.schedule-agent-composer textarea').fill('每天早上 9 点整理 Agent 行业动态');
await page.getByRole('button', { name: '生成草案', exact: true }).click();
await page.locator('.schedule-draft').waitFor({ state: 'visible' });
const scheduleDraftRequiresConfirmation = await page.getByText('待确认', { exact: true }).isVisible()
  && await page.getByRole('button', { name: '确认并启用', exact: true }).isVisible()
  && await page.locator('.schedule-card').count() === 1;
const scheduleNoHorizontalOverflow = await page.locator('.schedule-workspace').evaluate(() => document.body.scrollWidth <= innerWidth + 1);
await page.screenshot({ path: resolve(outputDir, 'dashboard-schedules.png'), fullPage: false });
await page.getByRole('button', { name: '关闭草案', exact: true }).click();
await page.unroute('**/api/schedules/draft');

const workflowListResponse = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/workflows', { timeout: 5_000 });
await page.getByRole('button', { name: 'Agent Nexus', exact: true }).click();
await page.locator('.dash-workflow-studio').waitFor({ state: 'visible', timeout: 8_000 });
await workflowListResponse;
const workflowWorkspaceUsesMainArea = await page.locator('.dash-main-workflows').isVisible();
const workflowWorkspaceUsesGlass = await page.locator('.workflow-canvas-shell').evaluate((element) => {
  const style = getComputedStyle(element);
  return style.backgroundImage.includes('radial-gradient') && style.backdropFilter.includes('blur') && style.borderRadius === '8px';
});
const workflowCanvasVisible = await page.locator('.workflow-canvas').isVisible();
await page.getByRole('button', { name: 'Nexus 设置', exact: true }).click();
const workflowNexusSettingsModal = await page.locator('.workflow-inspector-modal[aria-label="Nexus 设置"]').isVisible();
const workflowNexusSettingsFields = await page.locator('.workflow-inspector-modal[aria-label="Nexus 设置"] input, .workflow-inspector-modal[aria-label="Nexus 设置"] textarea, .workflow-inspector-modal[aria-label="Nexus 设置"] select').count() === 3;
await page.getByRole('button', { name: '关闭 Nexus 设置', exact: true }).click();
const workflowLayoutRects = await page.locator('.workflow-canvas-shell, .workflow-runner').evaluateAll((elements) => elements.map((element) => {
  const rect = element.getBoundingClientRect();
  return { className: element.className, left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}));
const workflowCanvasRect = workflowLayoutRects.find((item) => String(item.className).includes('workflow-canvas-shell'));
const workflowRunnerRect = workflowLayoutRects.find((item) => String(item.className).includes('workflow-runner'));
const workflowRunnerIsRightRail = Boolean(workflowCanvasRect && workflowRunnerRect)
  && workflowRunnerRect.left > workflowCanvasRect.right
  && Math.abs(workflowRunnerRect.top - workflowCanvasRect.top) <= 1
  && Math.abs(workflowRunnerRect.bottom - workflowCanvasRect.bottom) <= 1;
const workflowLibraryScrollable = await page.locator('.workflow-library').evaluate((element) => {
  const style = getComputedStyle(element);
  return style.overflowY === 'auto' && style.overflowX === 'hidden';
});
const workflowAgentEmojiVisible = await page.locator('.workflow-node.type-agent .workflow-agent-emoji').count() > 0;
const readWorkflowLayout = async () => page.locator('.dash-workflow-studio, .workflow-studio-grid').evaluateAll((elements) => elements.map((element) => {
  const rect = element.getBoundingClientRect();
  return { className: element.className, top: rect.top, height: rect.height, bottom: rect.bottom };
}));
await page.locator('.workflow-node.type-output').click({ force: true });
await page.waitForTimeout(80);
const workflowInspectorModalCentered = await page.locator('.workflow-inspector-modal-panel').evaluate((element) => {
  const rect = element.getBoundingClientRect();
  return Math.abs((rect.left + rect.width / 2) - innerWidth / 2) <= 1
    && Math.abs((rect.top + rect.height / 2) - innerHeight / 2) <= 1;
});
const outputWorkflowLayout = await readWorkflowLayout();
await page.getByRole('button', { name: '关闭设置', exact: true }).click();
await page.locator('.workflow-node.type-agent').first().click();
await page.waitForTimeout(80);
const agentWorkflowLayout = await readWorkflowLayout();
const outputGridLayout = outputWorkflowLayout.find((item) => String(item.className).includes('workflow-studio-grid'));
const agentGridLayout = agentWorkflowLayout.find((item) => String(item.className).includes('workflow-studio-grid'));
const outputStudioLayout = outputWorkflowLayout.find((item) => String(item.className).includes('dash-workflow-studio'));
const agentStudioLayout = agentWorkflowLayout.find((item) => String(item.className).includes('dash-workflow-studio'));
const workflowSelectionKeepsLayoutStable = Boolean(outputGridLayout && agentGridLayout && outputStudioLayout && agentStudioLayout)
  && Math.abs(outputGridLayout.height - agentGridLayout.height) <= 1
  && Math.abs(outputGridLayout.bottom - outputStudioLayout.bottom) <= 1
  && Math.abs(agentGridLayout.bottom - agentStudioLayout.bottom) <= 1;
const workflowInspectorModalNoLayoutShift = Boolean(outputGridLayout && agentGridLayout)
  && Math.abs(outputGridLayout.top - agentGridLayout.top) <= 1
  && Math.abs(outputGridLayout.height - agentGridLayout.height) <= 1;
const workflowInspectorText = await page.locator('.workflow-inspector').innerText();
const workflowUsesAgentTerms = workflowInspectorText.includes('Agent 设置')
  && workflowInspectorText.includes('Agent 目标')
  && workflowInspectorText.includes('Agent 能力')
  && !/模型覆盖|最大 Token|超时（秒）|失败处理|节点工具/u.test(workflowInspectorText);
await page.getByRole('button', { name: '关闭设置', exact: true }).click();
const workflowEdgesMeetPortCenters = await page.evaluate(() => {
  const parseTranslate = (value) => {
    const match = value.match(/translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/);
    return match ? { x: Number(match[1]), y: Number(match[2]) } : null;
  };
  const dimensions = (node) => node.classList.contains('type-agent') ? { width: 184, height: 86 } : { width: 150, height: 70 };
  return [...document.querySelectorAll('.workflow-edge .line')].every((line) => {
    const d = line.getAttribute('d') ?? '';
    const values = [...d.matchAll(/-?[\d.]+/g)].map((match) => Number(match[0]));
    if (values.length < 4) return false;
    const pathEnd = { x: values[values.length - 2], y: values[values.length - 1] };
    const edge = line.closest('.workflow-edge');
    const marker = edge?.querySelector('.line');
    const targetName = edge?.getAttribute('data-target');
    if (!marker || !targetName) return true;
    const target = document.querySelector(`[data-node-id="${CSS.escape(targetName)}"]`);
    const translate = target ? parseTranslate(target.getAttribute('style') ?? '') : null;
    if (!target || !translate) return true;
    const size = dimensions(target);
    return Math.abs(pathEnd.x - translate.x) < 1 && Math.abs(pathEnd.y - (translate.y + size.height / 2)) < 1;
  });
});
const workflowDefaultNodeCount = await page.locator('.workflow-node').count();
const workflowDefaultEdgeCount = await page.locator('.workflow-edge').count();
const agentNode = page.locator('.workflow-node.type-agent').first();
const nodeTransformBeforeDrag = await agentNode.getAttribute('style');
const nodeBox = await agentNode.boundingBox();
if (nodeBox) {
  await page.mouse.move(nodeBox.x + nodeBox.width / 2, nodeBox.y + nodeBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(nodeBox.x + nodeBox.width / 2 + 48, nodeBox.y + nodeBox.height / 2 + 24, { steps: 6 });
  await page.mouse.up();
}
const nodeTransformAfterDrag = await agentNode.getAttribute('style');
const workflowNodeDragWorks = nodeTransformBeforeDrag !== nodeTransformAfterDrag;
await page.getByRole('button', { name: 'Loop 回边', exact: true }).click();
const workflowLoopModeAvailable = await page.getByRole('button', { name: 'Loop 回边', exact: true }).evaluate((element) => element.classList.contains('active'));
await page.getByRole('button', { name: '普通连线', exact: true }).click();
const workflowSaveResponse = page.waitForResponse((response) => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/workflows', { timeout: 8_000 });
await page.getByLabel('Agent Nexus 名称', { exact: true }).fill(`视觉验收工作流-${fixtureStamp}`);
await page.getByRole('button', { name: '保存', exact: true }).click();
const savedWorkflowResponse = await workflowSaveResponse;
qaWorkflowId = (await savedWorkflowResponse.json()).workflow?.id ?? null;
const workflowSaveWorks = savedWorkflowResponse.ok() && Boolean(qaWorkflowId);
await page.getByRole('button', { name: '创建 Nexus 私有 Agent', exact: true }).click();
await page.getByPlaceholder('Agent 名称', { exact: true }).fill('工作流私有验证员');
await page.getByPlaceholder('角色 ID，如 prompt-designer', { exact: true }).fill('workflow-private-reviewer');
await page.getByPlaceholder('系统提示词', { exact: true }).fill('只检查当前工作流内的上游输出，不参与平台全局 Planner。');
await page.getByRole('button', { name: '创建并加入画布', exact: true }).click();
const workflowScopedAgentCreated = await page.getByText('工作流私有验证员', { exact: true }).count() >= 2
  && await page.locator('.workflow-node').count() === workflowDefaultNodeCount + 1;
const workflowInspectorVisible = await page.locator('.workflow-inspector').isVisible();
const workflowRunnerVisible = await page.locator('.workflow-runner').isVisible();
await page.getByRole('button', { name: '关闭设置', exact: true }).click();
await page.screenshot({ path: resolve(outputDir, 'dashboard-workflows.png'), fullPage: false });
await page.locator('.dash-nav-new').click();
await page.locator('.dash-chat-workspace').waitFor({ state: 'visible', timeout: 5_000 });
const input = page.locator('.dash-chat-composer textarea');
const qaPrompt = '请用一句话确认当前对话可以实时返回。';
await input.fill(qaPrompt);
await page.locator('.dash-chat-controls .send').click();
await page.locator('.dash-chat-workspace').waitFor({ state: 'visible', timeout: 5_000 });
await page.locator('.dash-chat-message.user').last().waitFor({ state: 'visible', timeout: 5_000 });
qaSessionId = await page.locator('.dash-chat-session-item.selected').getAttribute('data-session-id');
const immediateUserMessage = (await page.locator('.dash-chat-message.user').last().textContent())?.includes(qaPrompt) ?? false;
await page.waitForFunction(() => Boolean(document.querySelector('.dash-chat-message.assistant, .dash-chat-error')), undefined, { timeout: 8_000 });
const assistantReaction = await page.locator('.dash-chat-message.assistant, .dash-chat-error').count() > 0;
const activityIndicator = page.locator('.dash-chat-thinking').last();
const activityText = await activityIndicator.count() > 0 ? (await activityIndicator.innerText()).trim() : '';
const pendingActivityUsesAgentAction = activityText.length > 0
  && /Agent/u.test(activityText)
  && !/模型生成中|持续生成|模型正在/u.test(activityText);
await page.waitForFunction(() => document.querySelectorAll('.dash-agent-signal-node').length > 0, undefined, { timeout: 10_000 }).catch(() => undefined);
for (let attempt = 0; attempt < 40 && !qaTaskId; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
}
const agentBallCount = await page.locator('.dash-agent-signal-node').count();
const chatModel = (await page.locator('.dash-current-model strong').textContent())?.trim() ?? '';
const graphBeforeSessionSwitch = await page.locator('.dash-agent-signal-node').evaluateAll((elements) => elements.map((element) => element.textContent?.trim() ?? ''));
let graphClearsForNewSession = false;
let graphRestoresForPreviousSession = false;
if (await page.locator('.dash-nav-new').count() > 0 && await page.locator('.dash-chat-session-item').count() > 0) {
  await page.locator('.dash-nav-new').click();
  await page.waitForTimeout(180);
  graphClearsForNewSession = await page.locator('.dash-agent-signal-node').count() === 0;
  // The task lifecycle fixture also creates a task-backed session. Select the
  // exact conversation we just exercised instead of relying on list order.
  const previousSession = qaSessionId
    ? page.locator(`.dash-chat-session-item[data-session-id="${qaSessionId}"]`)
    : page.locator('.dash-chat-session-item:not(.selected)').first();
  if (await previousSession.count() > 0) {
    await previousSession.locator('.dash-chat-session-main').click();
    await page.waitForFunction((expected) => document.querySelectorAll('.dash-agent-signal-node').length >= expected, Math.max(1, graphBeforeSessionSwitch.length), { timeout: 8_000 }).catch(() => undefined);
    graphRestoresForPreviousSession = await page.locator('.dash-agent-signal-node').count() >= Math.max(1, graphBeforeSessionSwitch.length);
  }
}
const chatSideSplit = await page.locator('.dash-chat-side').evaluate((element) => {
  const side = element.getBoundingClientRect();
  const sessions = element.querySelector('.dash-chat-sessions')?.getBoundingClientRect();
  return sessions ? sessions.height / side.height : 0;
});
const sessionTimes = await page.locator('.dash-chat-session-item').evaluateAll((elements) => elements.map((element) => Number(element.getAttribute('data-updated-at') ?? 0)));
const sessionsNewestFirst = sessionTimes.every((value, index) => index === 0 || sessionTimes[index - 1] >= value);
const agentGraphVisible = await page.locator('.dash-agent-signal-graph').isVisible();
const morphIconMounted = await page.locator('.dash-chat-controls .send svg path').count() > 0;
const sessionDeleteAvailable = await page.locator('.dash-chat-session-delete').count() > 0;
let glassDeleteConfirmation = false;
let deleteConfirmationMinimal = false;
if (sessionDeleteAvailable) {
  await page.locator('.dash-chat-session-delete').first().click();
  await page.locator('.dash-confirm-dialog').waitFor({ state: 'visible', timeout: 3_000 });
  glassDeleteConfirmation = await page.locator('.dash-confirm-dialog').evaluate((element) => {
    const style = getComputedStyle(element);
    return style.backgroundImage.includes('radial-gradient') && style.backdropFilter.includes('blur');
  });
  deleteConfirmationMinimal = await page.locator('.dash-confirm-dialog').evaluate((element) => {
    const title = element.querySelector('h2')?.textContent?.trim();
    const buttons = [...element.querySelectorAll('button')].map((button) => button.textContent?.trim());
    return title === '确认删除？' && element.querySelectorAll('p').length === 0 && buttons.join('|') === '取消|删除';
  });
  await page.screenshot({ path: resolve(outputDir, 'dashboard-delete-confirm.png'), fullPage: false });
  await page.locator('.dash-confirm-actions button').first().click();
}
await page.screenshot({ path: resolve(outputDir, 'dashboard-chat.png'), fullPage: false });

qaArtifactSessionId = `qa-artifact-${fixtureStamp}`;
const artifactFixtureResponse = await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(qaArtifactSessionId)}`, {
  method: 'PUT',
  headers: { ...qaHeaders, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    id: qaArtifactSessionId,
    title: 'Artifact 渲染验收',
    updatedAt: Date.now(),
    messages: [
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `${qaArtifactSessionId}-history-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `历史消息 ${index + 1}：用于验证打开长会话时首帧直接定位到底部。`,
        createdAt: Date.now() - (26 - index) * 1_000,
      })),
      { id: `${qaArtifactSessionId}-user`, role: 'user', content: '渲染这三个可交互成果。', createdAt: Date.now() - 1 },
      {
        id: `${qaArtifactSessionId}-assistant`,
        role: 'assistant',
        createdAt: Date.now(),
        content: '# 可交付成果\n\n```svg\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 100"><rect width="160" height="100" rx="12" fill="#07130d"/><circle cx="80" cy="50" r="30" fill="#2bea78"/><text x="80" y="55" fill="#07130d" text-anchor="middle" font-family="sans-serif">SVG</text></svg>\n```\n\n```html\n<!doctype html><html lang="zh-CN"><body style="margin:0;display:grid;place-items:center;min-height:100vh;background:#09120e;color:#eafff1;font:16px system-ui"><button style="padding:12px 18px">HTML 预览</button></body></html>\n```\n\n```md\n## Markdown 预览\n\n| 项目 | 状态 |\n| --- | --- |\n| 表格 | 已渲染 |\n```',
      },
    ],
  }),
});
if (!artifactFixtureResponse.ok) throw new Error(`视觉 QA Artifact fixture 创建失败 (${artifactFixtureResponse.status})`);
// A workflow task keeps its SSE stream open while it finishes; waiting for
// network idle here would block the rest of the visual checks indefinitely.
await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('.axiom-dashboard').waitFor({ state: 'visible', timeout: 20_000 });
await page.getByRole('button', { name: '对话', exact: true }).click();
const artifactSession = page.locator(`[data-session-id="${qaArtifactSessionId}"]`);
await artifactSession.waitFor({ state: 'visible', timeout: 10_000 });
await artifactSession.locator('.dash-chat-session-main').click();
await page.waitForFunction(() => document.querySelectorAll('.dash-chat-message').length >= 26, undefined, { timeout: 5_000 });
const historyScrollPosition = await page.locator('.dash-chat-messages').evaluate((element) => ({
  top: element.scrollTop,
  bottom: element.scrollHeight - element.clientHeight,
  distance: element.scrollHeight - element.clientHeight - element.scrollTop,
}));
const historySessionOpensAtBottom = Math.abs(historyScrollPosition.distance) <= 2;
await page.locator('.dash-chat-artifact').first().waitFor({ state: 'visible', timeout: 5_000 });
const artifactKindsRender = await Promise.all(['markdown', 'svg', 'html'].map((kind) => page.locator(`.dash-chat-artifact.${kind}`).count()))
  .then((counts) => counts.every((count) => count === 1));
const artifactActionsAvailable = await page.locator('.dash-chat-artifact').evaluateAll((elements) => elements.every((element) => (
  element.querySelector('button[title="复制源码"]') && element.querySelector('button[title="下载"]')
)));
const artifactFramesAreOpaque = await page.locator('.dash-chat-artifact iframe').evaluateAll((elements) => elements.length === 2 && elements.every((element) => {
  const sandbox = element.getAttribute('sandbox') ?? '';
  return !sandbox.includes('allow-same-origin');
}));
const markdownTableRendered = await page.locator('.dash-chat-artifact.markdown table').isVisible();
const svgPreview = page.frameLocator('.dash-chat-artifact.svg iframe').locator('svg');
const htmlPreview = page.frameLocator('.dash-chat-artifact.html iframe').getByText('HTML 预览', { exact: true });
// iframe content can become available a few ticks after the host artifact is
// mounted. Waiting only on frameLocator text is racy: Playwright may inspect
// the frame before its srcdoc document has reached `complete`. Wait for both
// the document lifecycle and a concrete rendered element before asserting
// visibility, so a transient scheduler delay is not reported as a visual bug.
const waitForFrameContent = async (selector, predicate) => {
  await page.locator(selector).waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForFunction(({ frameSelector, expected }) => {
    const iframe = document.querySelector(frameSelector);
    if (!(iframe instanceof HTMLIFrameElement)) return false;
    const documentRef = iframe.contentDocument;
    if (!documentRef || documentRef.readyState !== 'complete' || !documentRef.body) return false;
    try {
      return expected === 'svg'
        ? Boolean(documentRef.body.querySelector('svg'))
        : Boolean(documentRef.body.querySelector('button') && documentRef.body.textContent?.includes('HTML'));
    } catch {
      return false;
    }
  }, { frameSelector: selector, expected: predicate }, { timeout: 10_000 });
};
await waitForFrameContent('.dash-chat-artifact.svg iframe', 'svg').catch(() => undefined);
await waitForFrameContent('.dash-chat-artifact.html iframe', 'html').catch(() => undefined);
const svgPreviewRendered = await svgPreview.isVisible().catch(() => false);
const htmlPreviewRendered = await htmlPreview.isVisible().catch(() => false);
await page.screenshot({ path: resolve(outputDir, 'dashboard-chat-artifacts.png'), fullPage: false });

let qaTaskTerminal = !qaTaskId;
if (qaTaskId) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(qaTaskId)}`, { headers: qaHeaders }).catch(() => null);
    const body = await response?.json().catch(() => null);
    if (['completed', 'failed', 'cancelled'].includes(body?.task?.status)) {
      qaTaskTerminal = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
await page.getByRole('button', { name: '任务管理', exact: true }).click();
await page.locator('.dash-task-board').waitFor({ state: 'visible' });
if (qaTaskId && qaTaskTerminal) {
  await page.locator(`.dash-task-row[data-task-id="${qaTaskId}"], .dash-task-row[data-session-id]`).first().waitFor({ state: 'visible', timeout: 20_000 });
  await page.locator('.dash-task-delete').first().waitFor({ state: 'visible', timeout: 20_000 });
}
const taskDeleteAvailable = await page.locator('.dash-task-delete').count() > 0;
const taskLayout = await layout(page);
const taskRowTitles = await page.locator('.dash-task-row-title').allTextContents();
const taskGroupKeys = await page.locator('.dash-task-row').evaluateAll((elements) => elements.map((element) => element.getAttribute('data-session-id') || element.getAttribute('data-task-id') || ''));
const sessionTaskGroupsUnique = taskGroupKeys.every(Boolean) && new Set(taskGroupKeys).size === taskGroupKeys.length;
const groupedRunCountVisible = await page.locator('.dash-task-row-meta').count() === taskRowTitles.length;
const rightRailShare = taskLayout.taskOrbitWidth / Math.max(1, taskLayout.taskBoardWidth + taskLayout.taskOrbitWidth);
let selectedTaskGreen = true;
let selectedOrbitGreen = true;
let orbitMoves = true;
let orbitCardSelectionWorks = true;
let orbitPointerDragWorks = true;
let selectedCardFocused = true;
let selectedFocusOffset = 0;
let orbitCardScaled = true;
let taskLifecycleVisible = false;
if (await page.locator('.dash-task-row').count() > 0) {
  await page.locator('.dash-task-row').first().click();
  await page.locator('.dash-task-row.selected').waitFor({ state: 'visible', timeout: 5_000 });
  // Selection updates the detail rail through React state; wait for the
  // selected task's detail payload before checking the lifecycle view.
  await page.locator('.dash-detail-task-id, .dash-lifecycle').first().waitFor({ state: 'visible', timeout: 10_000 });
  taskLifecycleVisible = await page.locator('.dash-lifecycle').isVisible();
  selectedTaskGreen = await page.locator('.dash-task-row.selected').evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.borderColor} ${style.backgroundImage} ${style.boxShadow}`.includes('43, 234, 120');
  });
  await page.locator('.dash-orbit-card.selected').waitFor({ state: 'visible', timeout: 5_000 });
  selectedOrbitGreen = await page.locator('.dash-orbit-card.selected .dash-orbit-card-shell').evaluate((element) => {
    const style = getComputedStyle(element);
    return `${style.borderColor} ${style.backgroundImage} ${style.boxShadow}`.includes('43, 234, 120');
  });
  const cardSize = await page.locator('.dash-orbit-card').first().evaluate((element) => {
    const style = getComputedStyle(element);
    return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
  });
  orbitCardScaled = cardSize.width >= 170 && cardSize.height >= 300;
  const orbitFirstTransform = await page.locator('.dash-orbit-card').first().getAttribute('style');
  await page.waitForTimeout(800);
  const orbitSecondTransform = await page.locator('.dash-orbit-card').first().getAttribute('style');
  orbitMoves = await page.locator('.dash-orbit-card').count() <= 1 || orbitFirstTransform !== orbitSecondTransform;
  const selectionCandidate = page.locator('.dash-orbit-card:not(.selected)').first();
  if (await selectionCandidate.count() > 0) {
    const candidateTaskId = await selectionCandidate.getAttribute('data-task-id');
    await selectionCandidate.evaluate((element) => element.click());
    await page.waitForFunction((taskId) => document.querySelector('.dash-orbit-card.selected')?.getAttribute('data-task-id') === taskId, candidateTaskId, { timeout: 5_000 });
    orbitCardSelectionWorks = await page.locator('.dash-orbit-card.selected').getAttribute('data-task-id') === candidateTaskId;
  }
  const dragStage = await page.locator('.dash-orbit-stage').boundingBox();
  const selectedBeforeDrag = await page.locator('.dash-orbit-card.selected').boundingBox();
  if (dragStage && selectedBeforeDrag) {
    await page.mouse.move(dragStage.x + dragStage.width * .55, dragStage.y + dragStage.height * .5);
    await page.mouse.down();
    const selectedTransformBeforeDrag = await page.locator('.dash-orbit-card.selected').getAttribute('style');
    await page.mouse.move(dragStage.x + dragStage.width * .72, dragStage.y + dragStage.height * .5, { steps: 8 });
    const selectedTransformDuringDrag = await page.locator('.dash-orbit-card.selected').getAttribute('style');
    await page.mouse.up();
    await page.waitForTimeout(120);
    orbitPointerDragWorks = selectedTransformBeforeDrag !== selectedTransformDuringDrag;
  }
  await page.locator('.dash-orbit-focus').click();
  await page.waitForTimeout(750);
  const stageBox = await page.locator('.dash-orbit-stage').boundingBox();
  const selectedBox = await page.locator('.dash-orbit-card.selected').boundingBox();
  selectedFocusOffset = stageBox && selectedBox
    ? Math.abs((selectedBox.x + selectedBox.width / 2) - (stageBox.x + stageBox.width / 2))
    : Number.POSITIVE_INFINITY;
  selectedCardFocused = selectedFocusOffset < 55;
}
await page.setViewportSize({ width: 390, height: 844 });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('.axiom-dashboard').waitFor({ state: 'visible', timeout: 20_000 });
await page.getByRole('button', { name: 'Agent Nexus', exact: true }).click();
await page.locator('.dash-workflow-studio').waitFor({ state: 'visible', timeout: 8_000 });
const mobileWorkflowLayout = await layout(page);
const workflowWorkspaceStartsAtTop = await page.evaluate(() => {
  const layout = document.querySelector('.dash-layout');
  const main = document.querySelector('.dash-main-workflows');
  const studio = document.querySelector('.dash-workflow-studio');
  if (!layout || !main || !studio) return false;
  const layoutRect = layout.getBoundingClientRect();
  const studioRect = studio.getBoundingClientRect();
  return layout.scrollTop === 0 && main.scrollTop === 0 && studioRect.top >= layoutRect.top + 70;
});
await page.screenshot({ path: resolve(outputDir, 'dashboard-workflows-mobile.png'), fullPage: false });
await page.getByRole('button', { name: '日程', exact: true }).click();
await page.locator('.schedule-workspace').waitFor({ state: 'visible', timeout: 5_000 });
const mobileScheduleNoHorizontalOverflow = await page.evaluate(() => document.body.scrollWidth <= innerWidth + 1);
const mobileScheduleComposerVisible = await page.locator('.schedule-agent-composer textarea').isVisible();
await page.screenshot({ path: resolve(outputDir, 'dashboard-schedules-mobile.png'), fullPage: false });
await page.getByRole('button', { name: '对话', exact: true }).click();
await page.locator('.dash-chat-workspace').waitFor({ state: 'visible', timeout: 5_000 });
const mobileLayout = await layout(page);
await page.screenshot({ path: resolve(outputDir, 'dashboard-chat-mobile.png'), fullPage: false });

const assertions = {
  defaultDashboard: dashboardLayout.dashboard,
  legacyShellRemovedFromFlow: !dashboardLayout.legacyShell,
  dashboardHasVisualContent: dashboardPixels.quantizedColors > 6 && dashboardPixels.averageLuminance > 3,
  liquidGlassSurfaceActive: glassSurfaceActive,
  tokenHeadingReadable,
  currentModelIsVisible: currentModel.length > 0,
  themeChoicesVisible,
  themePopoverEscapesHeader,
  themeSwitchWorks,
  themePersists,
  deepGrayThemeReadable,
  chatModelMatchesHeader: chatModel === currentModel,
  dailyWorkProcessVisible: dailyProcessVisible,
  timelineDefaultsToToday: timelineDate.includes(today.dayLabel),
  tokenTrendIncludesToday: tokenEndDate === today.dateKey,
  dailyProcessHasUsableViewport: timelineBefore.client >= 120 && timelineVisibleHeight >= timelineBefore.client + 60,
  dailyProcessSupportsWheelScrolling: timelineWheelWorks,
  immediateUserMessage,
  assistantReaction,
  pendingActivityUsesAgentAction,
  directResponseShowsAgentBall: agentBallCount > 0,
  newSessionClearsPreviousGraph: graphClearsForNewSession,
  selectingPreviousSessionRestoresGraph: graphRestoresForPreviousSession,
  historySessionOpensAtBottomWithoutAnimation: historySessionOpensAtBottom,
  recentSessionsUseHalfHeight: chatSideSplit >= .43 && chatSideSplit <= .53,
  sessionsNewestFirst,
  agentGraphVisible,
  morphIconMounted,
  sessionDeleteAvailable,
  glassDeleteConfirmation,
  deleteConfirmationIsMinimal: deleteConfirmationMinimal,
  noNativeBrowserDialog: !nativeDialogOpened,
  visualQaTaskReachedTerminal: qaTaskTerminal,
  sessionTaskGroupsUnique,
  groupedRunCountVisible,
  taskLifecycleVisible,
  rightTaskRailUsesMajority: rightRailShare >= 0.62,
  selectedTaskUsesGreen: selectedTaskGreen,
  selectedOrbitCardUsesGreen: selectedOrbitGreen,
    orbitCardsAreOnePointFiveScale: orbitCardScaled,
    orbitRotatesContinuously: orbitMoves,
    orbitCardSelectionWorks,
    orbitPointerDragWorks,
    focusReturnsSelectedCardToFront: selectedCardFocused,
  settingsOnlyExposeFourModelServices: settingsOnlyExposeModels,
  settingsUseDashboardGlass,
  providerLocationChoicesVisible,
  providerLocationSwitchWorks,
  pluginsUseMainWorkspace: pluginsUseWorkspace,
  pluginWorkspaceUsesGlass: pluginWorkspaceGlass,
  pluginGalleryUsesMaterialGlyphs,
  pluginGlyphHasFourRings,
  pluginNameBelowGlyph,
  pluginShellCreateVisible,
  pluginStyleChoicesAvailable,
  pluginDesignerWorkspaceVisible,
  pluginWindowResizeAvailable,
  pluginWindowResizeSaved,
  pluginWindowResizePersists,
  miniAppUsesExclusiveModal,
  miniAppBackdropUsesGlass,
  miniAppSandboxIsOpaque,
  pluginDeleteWarnsIrreversible,
  pluginRefreshSettles,
  pluginRefreshUsesSingleRequest: pluginRefreshIsSingleRequest,
  chatArtifactKindsRender: artifactKindsRender,
  chatArtifactActionsAvailable: artifactActionsAvailable,
  chatArtifactFramesAreOpaque: artifactFramesAreOpaque,
  markdownArtifactTableRendered: markdownTableRendered,
  svgArtifactPreviewRendered: svgPreviewRendered,
  htmlArtifactPreviewRendered: htmlPreviewRendered,
  leftNavSettingsRemoved,
  templatesUseMainWorkspace: templatesUseWorkspace,
  templateWorkspaceUsesGlass: templateWorkspaceGlass,
  templateModalRemoved: templatesUseWorkspace,
  templateRefreshSettles,
  templateRefreshUsesSingleRequest,
  scheduleComposerVisible,
  scheduleUsesGlass,
  scheduleFixtureVisible,
  scheduleRunControlsVisible,
  scheduleDraftRequiresConfirmation,
  scheduleNoHorizontalOverflow,
  mobileScheduleNoHorizontalOverflow,
  mobileScheduleComposerVisible,
  workflowUsesMainWorkspace: workflowWorkspaceUsesMainArea,
  workflowWorkspaceUsesGlass,
  workflowCanvasVisible,
  workflowNexusSettingsModal,
  workflowNexusSettingsFields,
  workflowInspectorModalCentered,
  workflowRunnerIsRightRail,
  workflowLibraryScrollable,
  workflowAgentEmojiVisible,
  workflowSelectionKeepsLayoutStable,
  workflowInspectorModalNoLayoutShift,
  workflowUsesAgentTerms,
  workflowEdgesMeetPortCenters,
  workflowHasInputAgentOutput: workflowDefaultNodeCount === 3,
  workflowEdgesRender: workflowDefaultEdgeCount === 2,
  workflowNodeDragWorks,
  workflowLoopModeAvailable,
  workflowSaveWorks,
  workflowScopedAgentCreated,
  workflowInspectorVisible,
  workflowConversationRunnerVisible: workflowRunnerVisible,
  leftNavToolsRemoved,
  headerReadinessStillAvailable,
  readinessUsesChinesePresentation,
  readinessUsesDashboardGlass,
  readinessTimeRemoved,
  desktopNoHorizontalOverflow: dashboardLayout.bodyScrollWidth <= dashboardLayout.viewportWidth + 1,
  mobileChatVisible: mobileLayout.chat,
  mobileWorkflowNoHorizontalOverflow: mobileWorkflowLayout.bodyScrollWidth <= mobileWorkflowLayout.viewportWidth + 1,
  workflowWorkspaceStartsAtTop,
  mobileNoHorizontalOverflow: mobileLayout.bodyScrollWidth <= mobileLayout.viewportWidth + 1,
  noBrowserErrors: consoleErrors.length === 0,
};
const result = {
  assertions,
  model: { header: currentModel, chat: chatModel },
  dates: { expected: today, timeline: timelineDate, tokenEnd: tokenEndDate },
  chatSideSplit: Number(chatSideSplit.toFixed(3)),
  taskRailShare: Number(rightRailShare.toFixed(3)),
  selectedFocusOffset: Number(selectedFocusOffset.toFixed(2)),
  agentBallCount,
  activityText,
  taskDeleteAvailableAtSnapshot: taskDeleteAvailable,
  timelineScroll: timelineBefore,
  historyScrollPosition,
  timelineVisibleHeight,
  pixels: dashboardPixels,
  layouts: { dashboard: dashboardLayout, tasks: taskLayout, mobile: mobileLayout, mobileWorkflow: mobileWorkflowLayout },
  consoleErrors,
  resizedMiniAppRect,
};
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (Object.values(assertions).some((passed) => !passed)) process.exitCode = 1;
} finally {
  if (qaTaskId) {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(qaTaskId)}`, { headers: qaHeaders }).catch(() => null);
      const body = await response?.json().catch(() => null);
      const status = body?.task?.status;
      if (['completed', 'failed', 'cancelled'].includes(status)) {
        await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(qaTaskId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
        break;
      }
      if (response?.ok && attempt === 0) {
        await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(qaTaskId)}/cancel`, { method: 'POST', headers: qaHeaders }).catch(() => undefined);
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  if (qaSessionId) {
    await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(qaSessionId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  }
  if (qaArtifactSessionId) {
    await fetch(`${baseUrl}/api/sessions/${encodeURIComponent(qaArtifactSessionId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  }
  if (qaPluginId) {
    await fetch(`${baseUrl}/api/plugins/${encodeURIComponent(qaPluginId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  }
  if (qaWorkflowId) {
    await fetch(`${baseUrl}/api/workflows/${encodeURIComponent(qaWorkflowId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  }
  if (qaScheduleId) {
    await fetch(`${baseUrl}/api/schedules/${encodeURIComponent(qaScheduleId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  }
  await browser.close();
}
