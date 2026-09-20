import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createServer as createNetServer } from 'node:net';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';

// Real React components with intercepted APIs keep this gate independent of user data and providers.
export async function runPopulatedLanguageSmoke() {
  const portProbe = createNetServer();
  await new Promise((resolve, reject) => { portProbe.once('error', reject); portProbe.listen(0, '127.0.0.1', resolve); });
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const server = await createServer({ server: { host: '127.0.0.1', port, strictPort: true, open: false }, logLevel: 'error' });
  let browser;
  const results = [];
  const errors = [];
  const unexpectedRequests = [];
  const mutations = [];
  const now = new Date().toISOString();
  const original = '研究员';
  const longText = '任务管理 / Preserve this exact user-authored content: ' + 'acceptance-evidence-'.repeat(30);
  const profile = { kind: 'research', route: 'team', difficulty: 'moderate', reasons: [], confidence: 0.9 };
  const task = (status = 'running', extra = {}) => ({
    id: 'language-task', revision: 4, runId: 'language-run', sessionId: 'language-session', userId: '用户', title: original,
    input: '任务管理', status, mode: 'analyze', createdAt: now, updatedAt: now, currentStage: status,
    completedSteps: 0, totalSteps: 1, tokens: { input: 120, output: 34, total: 154 }, profile,
    stepResults: [], toolApprovals: [], plan: { summary: longText, approvalStatus: 'approved',
      steps: [{ id: 'analysis', role: 'analyst', title: original, objective: '任务管理', dependsOn: [], acceptanceCriteria: [] }] }, ...extra,
  });
  let activeTask = task();
  let recovery = { enabled: true, canResume: false, executions: [] };
  let checkpoints = [];
  let branches = [];
  let actionFailure = false;
  let streamRelease;
  const customAgent = { id: 'custom-language', roleId: 'custom-language', name: original, description: '任务管理', kind: 'worker', status: 'published', visibility: 'private', version: 1, definition: { whenToUseHint: '任务管理', systemPromptTemplate: '任务管理', toolAllowlist: [] } };
  const businessRecord = { ownerId: '研究员', revision: 1, status: 'active', createdAt: now, updatedAt: now };
  const projectResponses = {
    '/api/capabilities/projects': { projects: [{ ...businessRecord, id: 'language-project', kind: 'project', data: { name: original, goal: '任务管理', acceptanceCriteria: ['任务管理'], strategy: '', members: [{ userId: '已完成', role: 'viewer' }], resources: {}, decisions: [] } }] },
    '/api/capabilities/projects/language-project/comments': { comments: [{ ...businessRecord, id: 'comment-source', data: { body: '任务管理' } }] },
    '/api/capabilities/projects/language-project/decisions': { decisions: [{ ...businessRecord, id: 'decision-source', status: 'accepted', data: { title: '研究员', decision: '任务管理', rationale: '', status: 'accepted' } }] },
    '/api/capabilities/projects/language-project/reviewers': { assignments: [{ ...businessRecord, id: 'review-source', status: 'approved', data: { reviewerId: '研究员', targetType: 'task', targetId: '已完成', reviewNote: '任务管理' } }] },
    '/api/capabilities/memories': { memories: [{ ...businessRecord, id: 'memory-source', kind: 'memory', data: { content: '任务管理', source: '已完成', layer: 'L1', confidence: .9, scope: 'user', enabled: true, syncState: 'local-policy' } }], memoryCore: 'degraded-local-policy' },
    '/api/capabilities/tool-sources': { sources: [{ ...businessRecord, id: 'tool-source', kind: 'tool-source', status: 'enabled', data: { name: '研究员', description: '任务管理', protocol: 'openapi', version: '1.0.0', location: 'local', categories: [], capabilityTags: ['已完成'], allowedAgentIds: [], healthStatus: 'healthy', riskLevel: 'low', endpoint: 'http://fixture.invalid' } }] },
    '/api/capabilities/tool-sources/tool-source/approvals': { approvals: [] },
    '/api/capabilities/capability-packs': { packs: [] },
    '/api/capabilities/integrations': { integrations: [{ ...businessRecord, id: 'connection-source', provider: 'feishu', name: '研究员', status: 'connected' }] },
    '/api/capabilities/solutions': { solutions: [] },
    '/api/capabilities/selection': { candidates: [], selectionPolicy: '' },
    '/api/capabilities/project-notifications': { notifications: [] },
  };
  const workflow = { id: 'language-workflow', name: '研究工作流', description: '任务管理', status: 'draft', visibility: 'private', version: 1,
    definition: { kind: 'agent-workflow', workflow: { schemaVersion: 1, nodes: [
      { id: 'input', type: 'input', name: 'Input', position: { x: 30, y: 100 } },
      { id: 'analysis', type: 'agent', name: original, objective: '任务管理', acceptanceCriteria: ['Check original source'], toolNames: ['workspace.read'], agentRef: { source: 'platform', id: customAgent.id }, position: { x: 220, y: 100 } },
      { id: 'output', type: 'output', name: 'Output', position: { x: 480, y: 100 } },
    ], edges: [{ id: 'first', source: 'input', target: 'analysis', kind: 'flow' }, { id: 'last', source: 'analysis', target: 'output', kind: 'flow' }], scopedAgents: [] } },
  };
  try {
    await server.listen();
    const baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
    const mainModule = await (await fetch(`${baseUrl}/src/main.tsx`)).text();
    const reactUrl = mainModule.match(/["']([^"']*\/react\.js[^"']*)["']/)?.[1];
    const reactDomUrl = mainModule.match(/["']([^"']*\/react-dom_client\.js[^"']*)["']/)?.[1];
    assert.ok(reactUrl && reactDomUrl);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, permissions: ['local-network-access'] });
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.text().includes('403 (Forbidden)')) errors.push(message.text()); });
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() !== 'GET') {
        mutations.push({ path, body: request.postDataJSON() });
        if (actionFailure) return route.fulfill({ status: 403, json: { error: 'No task management permission' } });
        if (path.endsWith('/resolve')) {
          recovery = { enabled: true, canResume: true, executions: [{ ...recovery.executions[0], status: 'retryable', requiresReview: false, resolution: { decision: 'confirmed-not-executed' } }] };
          return route.fulfill({ json: { execution: recovery.executions[0] } });
        }
        if (path.endsWith('/resume')) { activeTask = { ...activeTask, status: 'queued', revision: activeTask.revision + 1 }; return route.fulfill({ json: { task: activeTask, event: { sequence: 7 } } }); }
        unexpectedRequests.push(`${request.method()} ${path}`);
        return route.fulfill({ status: 400, json: { error: 'Unexpected fixture mutation' } });
      }
      if (path.endsWith('/tools/executions')) return route.fulfill({ json: recovery });
      if (path.endsWith('/checkpoints')) return route.fulfill({ json: { checkpoints, branches, currentRevision: activeTask.revision } });
      if (path.endsWith('/actions')) return route.fulfill({ json: { actions: [] } });
      if (path.endsWith('/events')) {
        const released = new Promise((resolve) => { streamRelease = resolve; });
        await released;
        return route.fulfill({ contentType: 'text/event-stream', body: `event: runtime\ndata: ${JSON.stringify({ id: 'language-completed', type: 'task.completed', taskId: activeTask.id, sequence: 8, timestamp: now, payload: {} })}\n\n` }).catch(() => {});
      }
      if (path === '/api/tasks/language-task') return route.fulfill({ json: { task: activeTask, actionPermissions: { canManage: true } } });
      if (path === '/api/workflows') return route.fulfill({ json: { workflows: [workflow] } });
      if (path.endsWith('/history')) return route.fulfill({ json: { activeTaskId: activeTask.id, tasks: [activeTask], messages: [{ id: 'original-message', role: 'user', content: '任务管理', createdAt: now }] } });
      if (path === '/api/agents/custom') return route.fulfill({ json: { agents: [customAgent] } });
      if (path === '/api/agents') return route.fulfill({ json: { agents: [] } });
      if (path === '/api/runtime/tools') return route.fulfill({ json: { tools: [{ name: 'workspace.read', description: 'Read a file' }] } });
      if (projectResponses[path]) return route.fulfill({ json: projectResponses[path] });
      unexpectedRequests.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 404, json: { error: 'Unexpected fixture read' } });
    });
    const fixture = `
import React from ${JSON.stringify(reactUrl)};
import ReactDOM from ${JSON.stringify(reactDomUrl)};
import {UiLanguageProvider,useUiLanguage} from '/src/lib/uiLanguage.tsx';
import {TaskActionPanel} from '/src/components/dashboard/TaskActionPanel.tsx';
import {TaskDetailPanel} from '/src/components/dashboard/TaskDetailPanel.tsx';
import {DashboardChat} from '/src/components/dashboard/DashboardChat.tsx';
import {WorkflowStudio} from '/src/components/dashboard/WorkflowStudio.tsx';
import {AgentStudio} from '/src/components/dashboard/AgentStudio.tsx';
import {ProjectWorkspace} from '/src/components/dashboard/ProjectWorkspace.tsx';
import {MiniAppWindow} from '/src/components/plugins/MiniAppWindow.tsx';
import '/src/styles.css'; import '/src/styles/dashboard.css';
const root=ReactDOM.createRoot(document.getElementById('root'));
const noop=()=>{}; window.languageQa={changed:[],sent:0,guided:0};
function Fixture({kind,task,running}) {
 const {setLanguage}=useUiLanguage(); window.languageQa.language=setLanguage;
 const [draft,setDraft]=React.useState('任务管理');
 const [tick,setTick]=React.useState(0); window.languageQa.refresh=()=>setTick(v=>v+1);
 const changed=async(id)=>window.languageQa.changed.push(id);
 const session={id:'language-session',title:'研究员',createdAt:Date.now(),updatedAt:Date.now(),messages:[{id:'user',role:'user',content:'任务管理',createdAt:Date.now()},{id:'answer',role:'assistant',content:'已完成',createdAt:Date.now(),pending:running}]};
 const chat={sessions:[session],activeSession:session,provider:'Fixture Provider',phase:running?'inference':'complete',mode:'analyze',draft,isRunning:running,canGuide:true,guidanceBusy:false,guidanceState:null,onGuidance:()=>window.languageQa.guided++,routeInsight:{route:'team',agentIds:['researcher','analyst'],skillIds:['web-research','evidence-research'],reason:'User reason',confidence:.9},agentActivity:'',error:null,onDraftChange:setDraft,onModeChange:noop,onSend:()=>window.languageQa.sent++,onStop:noop,onPause:noop,onResume:noop,onNewTask:noop,onSelectSession:noop,onDeleteSession:noop,attachments:[],onAddAttachments:noop,onRemoveAttachment:noop,agents:[],graph:null,events:[],selectedNodeId:null,onSelectAgent:noop,onTaskActionChanged:changed};
 const mini={id:'language-plugin',name:'研究员',definition:{type:'mini-app',width:640,height:480,agentEnabled:false,htmlContent:'<p>任务管理</p>'}};
 const content=kind==='project'?React.createElement(ProjectWorkspace,{onUseSolution:noop}):kind==='mini'?React.createElement(MiniAppWindow,{plugin:mini,onClose:noop,onAgentRequest:async()=>''}):kind==='nexus'?React.createElement(WorkflowStudio):kind==='agents'?React.createElement(AgentStudio):kind==='chat'?React.createElement(DashboardChat,chat):kind==='detail'?React.createElement(TaskDetailPanel,{task,sessionTopic:'研究员',taskProfile:task.profile,reviewResult:null,onResubmit:noop,onDeleteTask:noop,onCheckpointTaskCreated:changed}):React.createElement(TaskActionPanel,{taskId:task.id,taskStatus:task.status,refreshKey:tick,onChanged:changed,context:'task'});
 return React.createElement('main',{className:'axiom-dashboard',style:{padding:'18px',height:'100vh',overflow:'auto',display:'block'}},React.createElement('div',{className:'language-fixture',style:{maxWidth:['panel','detail'].includes(kind)?'440px':'none'}},content));
}
window.languageQa.mount=(kind,task,running=false)=>root.render(React.createElement(UiLanguageProvider,null,React.createElement(Fixture,{kind,task,running,key:kind+task.status})));
window.languageQa.mount('agents',${JSON.stringify(activeTask)});
`;
    await page.route('**/__qa/language.html*', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$=()=>{}; window.$RefreshSig$=()=>(type)=>type; window.__vite_plugin_react_preamble_installed__=true; await import("/__qa/language.js");</script></body></html>' }));
    await page.route('**/__qa/language.js', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }));
    const mount = (kind, running = false) => page.evaluate(({ kind, task, running }) => window.languageQa.mount(kind, task, running), { kind, task: activeTask, running });
    const language = async (value) => { await page.evaluate((value) => window.languageQa.language(value), value); await expect(page.locator('html')).toHaveAttribute('lang', value); };
    const check = async (name, run) => { await run(); results.push({ name, status: 'passed' }); };
    const assertFits = async (selector) => {
      const bounds = await page.locator(selector).evaluate((element) => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
      assert.ok(bounds.scrollWidth <= bounds.width + 1, `${selector} overflowed: ${JSON.stringify(bounds)}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Page has horizontal overflow');
    };
    const assertEnglishUi = async (selector) => {
      const untranslated = await page.locator(selector).evaluate((root) => {
        const values = [];
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const element = node.parentElement;
          if (element?.closest('[data-i18n-ignore="true"],pre,code,.dash-chat-markdown')) continue;
          const value = node.nodeValue?.trim() ?? '';
          if (/[\u3400-\u9fff]/u.test(value) && element?.getBoundingClientRect().width) values.push(value);
        }
        return values;
      });
      assert.deepEqual(untranslated, [], `${selector} contains untranslated UI copy`);
    };
    await page.goto(`${baseUrl}/__qa/language.html?lang=en`);
    await page.waitForSelector('.dash-agent-card');
    await check('custom Agent names and descriptions survive both languages', async () => {
      for (const value of ['en', 'zh-CN', 'en']) {
        await language(value);
        await expect(page.locator('.dash-agent-card-head strong')).toHaveText(original);
        await expect(page.locator('.dash-agent-card > p')).toHaveText('任务管理');
      }
    });
    await check('Mini App dialog and embedded content preserve the user-defined accessible name', async () => {
      await mount('mini');
      for (const value of ['en', 'zh-CN', 'en']) {
        await language(value);
        await expect(page.getByRole('dialog')).toHaveAccessibleName(original);
        await expect(page.locator('.mini-app-window iframe')).toHaveAttribute('title', original);
        await expect(page.frameLocator('.mini-app-window iframe').locator('p')).toHaveText('任务管理');
        await expect(page.locator('.mini-app-window-bar button')).toHaveAccessibleName(value === 'en' ? 'Close plugin' : '关闭插件');
      }
    });
    await check('populated project records, memory and custom tool sources retain original content', async () => {
      await mount('project');
      for (const value of ['en', 'zh-CN', 'en']) {
        await language(value);
        await page.locator('.business-tabs button').nth(0).click();
        for (const selector of ['.business-check-list li:not(.muted)', '.business-comments article > p', '.business-decision-list article > p', '.business-review-list article > p']) {
          await expect(page.locator(selector)).toHaveText('任务管理');
        }
        for (const selector of ['.business-comments article > strong', '.business-decision-list article > strong', '.business-review-list article > div > strong']) {
          await expect(page.locator(selector)).toHaveText(original);
        }
        await expect(page.locator('.business-member-list em')).toHaveText([original, '已完成']);
        await expect(page.locator('.business-review-list article > div > small > span')).toHaveText('已完成');
        await expect(page.locator('.business-review-list article > em')).toHaveText(value === 'en' ? 'Approved' : '已通过');
        await page.locator('.business-tabs button').nth(1).click();
        await expect(page.locator('.business-memory-list article > p')).toHaveText('任务管理');
        await expect(page.locator('.business-memory-list footer > span > span')).toHaveText('已完成');
        await page.locator('.business-tabs button').nth(2).click();
        await expect(page.locator('.business-connection-row strong')).toHaveText(original);
        await expect(page.locator('.business-tool-list article > header strong')).toHaveText(original);
        await expect(page.locator('.business-tool-list article > p')).toHaveText('任务管理');
        await expect(page.locator('.business-tool-capabilities > span')).toHaveText('已完成');
      }
    });
    await check('populated task status and lifecycle labels update while source text stays unchanged', async () => {
      for (const [status, english] of [['running', 'Executing'], ['awaiting_approval', 'Awaiting plan approval'], ['waiting_for_human', 'Awaiting human review'], ['failed', 'Failed']]) {
        activeTask = task(status);
        await mount('detail');
        await language('en');
        await expect(page.locator('.dash-detail-status')).toHaveText(english);
        await expect(page.locator('.dash-task-detail-summary h2')).toHaveText(original);
        await expect(page.locator('.dash-task-detail-summary > p')).toHaveText('任务管理');
        await expect(page.locator('.task-agent-control select')).toBeVisible();
        await assertEnglishUi('.dash-detail-panel');
        await expect(page.locator('.dash-lifecycle-step').nth(2)).toHaveAttribute('title', status === 'failed' ? 'Execute: Incomplete' : status === 'awaiting_approval' ? 'Execute: Not enabled' : 'Execute: In progress');
        await language('zh-CN');
        await expect(page.locator('.dash-lifecycle-step').nth(2)).toHaveAttribute('title', status === 'failed' ? '执行：未完成' : status === 'awaiting_approval' ? '执行：未启用' : '执行：进行中');
      }
    });
    await check('partial task evidence and unknown usage keep their meaning in both languages', async () => {
      activeTask = task('completed', { stepResults: [{ stepId: 'analysis', agentId: 'analyst', status: 'failed', durationMs: 23, evidenceDetails: [{ id: 'claim-source', kind: 'user-fact', claim: '任务管理', source: '已完成', verification: 'unverified', confidence: .5 }], handoff: { status: 'partial', summary: '任务管理', openQuestions: ['已完成'], evidenceIds: ['claim-source'], artifactIds: [] } }], evidenceSummary: { schemaVersion: 2, execution: 'partial', acceptance: 'not-recorded', completedSteps: 0, totalSteps: 1, evidenceItems: 1, artifactRefs: 0, toolReceipts: 1, gaps: ['任务管理'] } });
      checkpoints = [{ checkpointId: 'checkpoint-source', eventId: 'event-source', sequence: 3, createdAt: now, stage: 'final-delivery', revision: 3, planVersion: 1, graphRevision: 1, completedSteps: 0, failedSteps: 1, totalSteps: 1, restorable: true }];
      branches = [{ taskId: 'branch-source', checkpointId: 'checkpoint-source', kind: 'branch', title: original, status: 'completed', revision: 1, updatedAt: now }];
      await mount('detail');
      for (const value of ['en', 'zh-CN', 'en']) {
        await language(value);
        await expect(page.locator('.task-agent-control > p')).toContainText(value === 'en' ? 'Usage unavailable' : '用量未提供');
        await expect(page.locator('.task-agent-control > p')).not.toContainText('0 Token');
        await expect(page.locator('.task-agent-control option')).toHaveText(value === 'en' ? '研究员 · Analyst' : '研究员 · 分析员');
        await expect(page.locator('.dash-evidence-gaps')).toHaveText('任务管理');
        await expect(page.locator('.dash-evidence-summary')).toContainText(value === 'en' ? 'Execution incomplete' : '执行未完成');
        await expect(page.locator('.task-handoff-list article > p')).toHaveText('任务管理');
        await expect(page.locator('.task-handoff-list article > small')).toHaveText('已完成');
        await expect(page.locator('.task-handoff-list article .partial')).toHaveText(value === 'en' ? 'Partially completed' : '部分完成');
        await expect(page.locator('.dash-checkpoint-compare option')).toHaveText(value === 'en' ? '研究员 · Completed' : '研究员 · 已完成');
        await expect(page.locator('.task-evidence-correction option[value="claim-source"]')).toHaveText('任务管理');
        await expect(page.locator('.task-evidence-claim p')).toHaveText('任务管理');
        await expect(page.locator('.task-evidence-source strong')).toHaveText('已完成');
        await expect(page.locator('.task-evidence-graph .task-capability-head small')).toHaveText(value === 'en' ? '1 items' : '1 条');
      }
      await assertEnglishUi('.dash-detail-panel');
      checkpoints = []; branches = [];
    });
    await check('chat dynamic ARIA and source messages survive language and execution transitions', async () => {
      for (const value of ['en', 'zh-CN', 'en']) {
        await language(value);
        for (const running of [false, true, false]) {
          await mount('chat', running);
          const label = value === 'en' ? running ? 'Add to current task' : 'Send message' : running ? '加入当前任务' : '发送消息';
          await expect(page.locator('.dash-chat-controls .send')).toHaveAccessibleName(label);
          await expect(page.locator('.dash-chat-session-delete')).toHaveAccessibleName(`${value === 'en' ? 'Delete conversation' : '删除会话'} ${original}`);
          await expect(page.locator('.dash-chat-session-main strong')).toHaveText(original);
          await expect(page.locator('.dash-chat-markdown').first()).toHaveText('任务管理');
          await expect(page.locator('.dash-chat-markdown').last()).toHaveText('已完成');
          await expect(page.locator('.dash-route-insight em')).toHaveText(value === 'en' ? 'Researcher → Analyst' : '研究员 → 分析员');
          await page.locator('.dash-chat-controls .send').click();
        }
      }
      assert.deepEqual(await page.evaluate(() => [window.languageQa.sent, window.languageQa.guided]), [6, 3]);
      await page.setViewportSize({ width: 390, height: 844 });
      for (const value of ['en', 'zh-CN']) {
        await language(value); await mount('chat', true);
        await page.locator('.dash-chat-controls .send').scrollIntoViewIfNeeded();
        await expect(page.locator('.dash-chat-controls .send')).toBeInViewport();
        await assertFits('.dash-chat-composer');
      }
    });
    await check('390px plan, critical tool and quality review keep long content and reachable confirmations', async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      for (const value of ['en', 'zh-CN']) {
        await language(value);
        const zh = value === 'zh-CN';
        for (const kind of ['plan', 'tool', 'review']) {
          // Ordinary Allow Once is already an explicit decision and submits
          // immediately. This no-mutation dialog/layout case must use a critical
          // approval, whose additional confirmation remains mandatory. Immediate
          // noncritical approval/rejection is covered by task-actions-smoke.mjs.
          activeTask = task(kind === 'plan' ? 'awaiting_approval' : 'waiting_for_human', kind === 'plan' ? { plan: { ...task().plan, approvalStatus: 'pending' } } : kind === 'tool' ? { toolApprovals: [{ id: 'approval', status: 'pending', name: 'workspace.write', risk: 'critical', args: { content: longText }, requestedAt: now }] } : { review: { approved: false, score: 61, summary: longText, gaps: ['任务管理'], requiredCorrections: [] } });
          await mount('panel');
          await page.evaluate(() => window.languageQa.refresh());
          const action = page.getByRole('button', { name: kind === 'plan' ? zh ? '批准计划' : 'Approve Plan' : kind === 'tool' ? zh ? '允许此次调用' : 'Allow Once' : zh ? '批准交付' : 'Accept Result', exact: true });
          await action.scrollIntoViewIfNeeded(); await expect(action).toBeInViewport();
          await assertFits('.task-action-panel');
          if (kind === 'review') await expect(page.locator('.task-action-entry > p')).toHaveText(longText);
          await page.getByRole('textbox', { name: zh ? '审核意见' : 'Decision Notes' }).fill('任务管理');
          await action.click();
          await expect(page.getByRole('alertdialog')).toBeInViewport();
          await assertFits('[role="alertdialog"]');
          await page.keyboard.press('Escape');
        }
      }
      assert.equal(mutations.length, 0, 'Opening and dismissing confirmation must not send decisions');
      await mkdir('qa', { recursive: true });
      await page.screenshot({ path: 'qa/i18n-populated-mobile.png' });
    });
    await check('failure and external-outcome recovery remain bilingual and operate on the same task', async () => {
      activeTask = task('paused');
      recovery = { enabled: true, canResume: false, executions: [{ id: 'execution', toolName: 'workspace.write', status: 'outcome_unknown', revision: 2, requiresReview: true, resolution: null }] };
      await mount('panel');
      for (const value of ['en', 'zh-CN', 'en']) {
        await language(value);
        await expect(page.locator('.tool-recovery-entry > span')).toHaveText(value === 'en' ? 'External outcome needs review' : '外部结果待核对');
        await expect(page.locator('.tool-recovery textarea')).toHaveAccessibleName(value === 'en' ? 'Verification notes' : '核对依据');
      }
      await page.getByRole('textbox', { name: 'Verification notes' }).fill('任务管理');
      const resolve = page.getByRole('button', { name: 'Confirm Not Executed', exact: true });
      await resolve.scrollIntoViewIfNeeded(); await expect(resolve).toBeInViewport();
      await assertFits('.tool-recovery');
      await resolve.click();
      await expect(page.locator('.tool-recovery-entry > span')).toHaveText('Confirmed not executed');
      actionFailure = true;
      await page.getByRole('button', { name: 'Continue Task', exact: true }).click();
      await expect(page.locator('.tool-recovery [role="alert"]')).toBeVisible();
      await language('zh-CN');
      await expect(page.locator('.tool-recovery [role="alert"]')).toHaveText('操作未完成，请刷新记录后重试');
      await language('en'); actionFailure = false;
      await page.getByRole('button', { name: 'Continue Task', exact: true }).click();
      await expect.poll(() => page.evaluate(() => window.languageQa.changed.length)).toBeGreaterThan(0);
      assert.ok(mutations.every((entry) => entry.path.includes('/language-task/')));
      assert.equal(mutations[0].body.note ?? mutations[0].body.notes, '任务管理');
    });
    await check('Nexus name, Agent settings and dynamic port names preserve user naming at 390px', async () => {
      activeTask = task('paused'); recovery = { enabled: true, canResume: false, executions: [] };
      await mount('nexus');
      await expect(page.locator('.workflow-name-row input')).toHaveValue(workflow.name);
      for (const value of ['en', 'zh-CN', 'en']) {
        await language(value);
        await expect(page.locator('.workflow-node[data-node-id="analysis"] > strong')).toHaveText(original);
        await expect(page.locator('.workflow-node[data-node-id="analysis"] .workflow-port.input')).toHaveAccessibleName(`${value === 'en' ? 'Connect to' : '连接到'} ${original}`);
      }
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('.workflow-node[data-node-id="analysis"]').click();
      await expect(page.getByRole('dialog', { name: 'Agent settings', exact: true })).toBeVisible();
      await expect(page.getByRole('textbox', { name: 'Agent goal', exact: true })).toHaveValue('任务管理');
      await assertEnglishUi('.workflow-inspector-modal-panel');
      await page.getByRole('textbox', { name: 'Name', exact: true }).fill('任务管理');
      await page.setViewportSize({ width: 390, height: 844 });
      await assertFits('.workflow-inspector-modal-panel');
      await page.getByRole('button', { name: 'Save and close', exact: true }).scrollIntoViewIfNeeded();
      await expect(page.getByRole('button', { name: 'Save and close', exact: true })).toBeInViewport();
      await page.screenshot({ path: 'qa/i18n-agent-settings-mobile.png' });
      await page.keyboard.press('Escape');
      await expect(page.locator('.workflow-node[data-node-id="analysis"] .workflow-port.input')).toHaveAccessibleName('Connect to 任务管理');
      await language('zh-CN');
      await expect(page.locator('.workflow-node[data-node-id="analysis"] .workflow-port.input')).toHaveAccessibleName('连接到 任务管理');
    });
    await check('Nexus running-to-partial-result transition retains the actual result distinction', async () => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await language('en'); activeTask = task('running');
      await mount('nexus');
      await expect.poll(() => typeof streamRelease, { timeout: 10_000 }).toBe('function');
      await expect(page.locator('.workflow-runner > header')).toContainText('Agent Nexus is running');
      activeTask = task('completed', { result: '任务管理', stepResults: [{ stepId: 'analysis', agentId: 'analyst', status: 'completed', output: '任务管理', handoff: { status: 'partial' } }] });
      streamRelease();
      await expect(page.locator('.workflow-runner > header')).toContainText('Agent Nexus saved a partial result');
      await language('zh-CN');
      await expect(page.locator('.workflow-runner > header')).toContainText('Agent Nexus 已保存部分结果');
      await page.screenshot({ path: 'qa/i18n-populated-desktop.png' });
    });
    assert.deepEqual(errors, []);
    assert.deepEqual(unexpectedRequests, []);
    return { status: 'passed', scenarios: results, browserErrors: errors, unexpectedRequests, fixtureMutations: mutations.length };
  } catch (error) {
    const page = browser?.contexts()[0]?.pages()[0];
    process.stderr.write(`${JSON.stringify({ error: String(error), results, errors, unexpectedRequests, body: await page?.locator('body').innerText().catch(() => '') }, null, 2)}\n`);
    throw error;
  } finally {
    streamRelease?.();
    await browser?.close();
    await server.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runPopulatedLanguageSmoke(), null, 2));
}
