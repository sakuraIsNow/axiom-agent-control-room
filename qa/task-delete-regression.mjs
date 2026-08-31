import { chromium } from 'playwright';

const apiOrigin = process.env.AXIOM_API_ORIGIN || 'http://127.0.0.1:8787';
const webOrigin = process.env.AXIOM_WEB_ORIGIN || 'http://127.0.0.1:4300';
const qaHeaders = { 'x-axiom-tenant-id': 'qa-task-delete', 'x-axiom-user-id': 'qa-task-delete' };
const sessionId = `qa-task-delete-${Date.now()}`;
const title = `QA task delete ${Date.now()}`;
const createdIds = [];

const requestJson = async (path, init) => {
  const response = await fetch(`${apiOrigin}${path}`, {
    ...init,
    headers: { ...qaHeaders, ...(init?.headers ?? {}) },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${path} returned ${response.status}: ${body?.error || 'unknown error'}`);
  return body;
};

const waitFor = async (predicate, timeoutMs = 10_000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for task deletion state.');
};

const createCancelledTask = async (index) => {
  const body = await requestJson('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionId,
      title,
      input: `QA grouped deletion run ${index}`,
      mode: 'analyze',
    }),
  });
  const taskId = body.task?.id;
  if (!taskId) throw new Error('Task API did not return a task id.');
  createdIds.push(taskId);
  await fetch(`${apiOrigin}/api/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST', headers: qaHeaders });
  await waitFor(async () => {
    const current = await requestJson(`/api/tasks/${encodeURIComponent(taskId)}`);
    return current.task?.status === 'cancelled';
  });
};

let browser;
let context;
try {
  await createCancelledTask(1);
  await createCancelledTask(2);

  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, extraHTTPHeaders: qaHeaders });
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  await page.goto(webOrigin, { waitUntil: 'domcontentloaded' });
  await page.locator('.dash-task-board').waitFor({ state: 'visible' });

  const groupedRow = page.locator(`.dash-task-row[data-session-id="${sessionId}"]`);
  await groupedRow.waitFor({ state: 'visible' });
  const meta = await groupedRow.locator('.dash-task-row-meta').textContent();
  if (!meta?.includes('2')) throw new Error(`Expected grouped run count, got: ${meta || '(empty)'}`);

  await groupedRow.click();
  await groupedRow.waitFor({ state: 'visible' });
  await page.locator('.dash-task-row.selected').waitFor({ state: 'visible' });
  await page.waitForTimeout(500);
  if (await groupedRow.locator('xpath=..').locator('.dash-task-delete').count() !== 1) {
    throw new Error('Selecting a terminal task removed its delete action.');
  }
  await groupedRow.locator('xpath=..').locator('.dash-task-delete').click();
  await page.locator('.dash-confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('.dash-confirm-actions button.danger').click();
  await page.locator('.dash-confirm-dialog').waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => undefined);

  await waitFor(async () => {
    const current = await requestJson('/api/tasks?limit=100');
    return !current.tasks.some((task) => createdIds.includes(task.id));
  });
  await waitFor(async () => (await page.locator(`.dash-task-row[data-session-id="${sessionId}"]`).count()) === 0);

  console.log(JSON.stringify({ groupedRuns: 2, selectedBeforeDelete: true, deleteActionPersisted: true, deletedTaskIds: createdIds, cardRemoved: true }));
} finally {
  if (context) await context.close();
  if (browser) await browser.close();
  // Cleanup is idempotent and only targets tasks created by this run.
  for (const taskId of createdIds) await fetch(`${apiOrigin}/api/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
  await fetch(`${apiOrigin}/api/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE', headers: qaHeaders }).catch(() => undefined);
}
