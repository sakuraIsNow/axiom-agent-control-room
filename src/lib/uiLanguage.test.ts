import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_UI_LANGUAGE, normalizeUiLanguage, resolveInitialUiLanguage, translateUiText } from './uiLanguage';

test('English is the default UI language and query selection takes precedence', () => {
  assert.equal(DEFAULT_UI_LANGUAGE, 'en');
  assert.equal(resolveInitialUiLanguage(), 'en');
  assert.equal(resolveInitialUiLanguage({ stored: 'zh-CN' }), 'zh-CN');
  assert.equal(resolveInitialUiLanguage({ query: '?lang=en', stored: 'zh-CN' }), 'en');
  assert.equal(normalizeUiLanguage('zh-Hans'), 'zh-CN');
});

test('UI translations preserve product terms and support dynamic labels', () => {
  assert.equal(translateUiText('任务管理', 'en'), 'Tasks');
  assert.equal(translateUiText('Agent Nexus · 智能体枢纽', 'en'), 'Agent Nexus');
  assert.equal(translateUiText('删除会话 研究记录', 'en'), 'Delete conversation 研究记录');
  assert.equal(translateUiText('同步中…', 'en'), 'Syncing...');
  assert.equal(translateUiText('正在读取运行数据', 'en'), 'Loading runtime data');
  assert.equal(translateUiText('任务管理', 'zh-CN'), '任务管理');
  assert.equal(translateUiText('DeepSeek API', 'en'), 'DeepSeek API');
});

test('Readiness translates blocked and provider protection states without weakening their meaning', () => {
  const cases = [
    ['请先处理下方标红的服务。', 'Resolve the services marked in red below first.'],
    ['模型服务暂时不可用', 'Model services are temporarily unavailable'],
    ['已阻断', 'Blocked'],
    ['任务模型配置保护', 'Task model configuration protection'],
    ['任务模型配置可加密保存并在重启后恢复。', 'Task model settings can be stored encrypted and restored after a restart.'],
    ['文本模型服务健康检查失败。', 'The text model service failed its health check.'],
    ['请配置并备份 AXIOM_PROVIDER_SECRET；任务入队需要加密保存模型配置，所有 Worker 必须使用同一密钥。', 'Configure and back up AXIOM_PROVIDER_SECRET. Task model settings must be encrypted before queueing, and all Workers must use the same key.'],
    ['1 项需要处理', '1 item requires attention'],
    ['3 项需要处理。', '3 items require attention.'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(translateUiText(source, 'en'), expected);
    assert.equal(translateUiText(source, 'zh-CN'), source);
  }
  const customDiagnostic = '模型返回原文：文本模型服务健康检查失败。 trace=provider-42';
  assert.equal(translateUiText(customDiagnostic, 'en'), customDiagnostic);
});

test('dynamic action labels preserve user names even when a name matches a UI translation', () => {
  const cases = [
    ['删除会话 研究员', 'Delete conversation 研究员'],
    ['删除任务 任务管理', 'Delete task 任务管理'],
    ['打开插件 运行中', 'Open plugin 运行中'],
    ['删除日程', 'Delete 日程'],
    ['从 分析员 开始连线', 'Start a connection from 分析员'],
    ['连接到 输出', 'Connect to 输出'],
    ['发布插件 审查员', 'Publish plugin 审查员'],
    ['研究员的阶段调用未完成', "研究员's stage call did not complete"],
  ];
  for (const [source, expected] of cases) {
    assert.equal(translateUiText(source, 'en'), expected);
    assert.equal(translateUiText(source, 'zh-CN'), source);
  }
});

test('populated execution states remain distinct in both languages', () => {
  const cases = [
    ['Agent 目标', 'Agent goal'],
    ['Agent Nexus 正在执行', 'Agent Nexus is running'],
    ['执行计划等待你的确认', 'The execution plan awaits your approval'],
    ['Agent Nexus 等待你处理', 'Agent Nexus needs your decision'],
    ['Agent Nexus 已保存部分结果', 'Agent Nexus saved a partial result'],
    ['Agent Nexus 执行未完成', 'Agent Nexus execution incomplete'],
    ['执行：进行中', 'Execute: In progress'],
    ['交付：未完成', 'Deliver: Incomplete'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(translateUiText(source, 'en'), expected);
    assert.equal(translateUiText(source, 'zh-CN'), source);
  }
});

test('Readiness configured-provider messages preserve arbitrary model identifiers', () => {
  const cases = [
    ['已配置 gpt-image-2.5-sunburst-cdx。', 'gpt-image-2.5-sunburst-cdx is configured.'],
    ['已配置 gpt-image-2-03。', 'gpt-image-2-03 is configured.'],
    ['已配置 任务管理。', '任务管理 is configured.'],
    ['已配置 vendor/team-model:2026-09，尚未探测模型服务连通性。', 'vendor/team-model:2026-09 is configured; model connectivity has not been checked.'],
    ['已配置本地视频模型 我的模型/v2。', 'Local video model 我的模型/v2 is configured.'],
  ];
  for (const [source, expected] of cases) {
    assert.equal(translateUiText(source, 'en'), expected);
    assert.equal(translateUiText(source, 'zh-CN'), source);
  }
  const customDiagnostic = '供应商原文：已配置 gpt-image-2.5-sunburst-cdx。';
  assert.equal(translateUiText(customDiagnostic, 'en'), customDiagnostic);
});

test('artifact and workspace descriptions distinguish standalone delivery from approved project writes', () => {
  const artifactDescription = '直接生成本次任务的独立 HTML、SVG、Markdown 或文本交付文件，无需人工确认。仅保存为任务附件，不执行内容、不访问或修改项目文件。用户要求画 SVG、制作网页动画或生成文档时优先使用；修改已有项目文件仍须使用 workspace.write/patch 并申请批准。';
  const workspaceDescription = '获得明确人工批准后写入或覆盖已有项目工作区中的 UTF-8 文件。用户仅需独立 HTML、SVG 或文档交付时使用 artifact.create，无需修改项目文件。';
  const artifactTranslation = translateUiText(artifactDescription, 'en');
  const workspaceTranslation = translateUiText(workspaceDescription, 'en');
  assert.doesNotMatch(artifactTranslation, /[\u3400-\u9fff]/u);
  assert.match(artifactTranslation, /do not execute its content or access or modify project files/);
  assert.match(artifactTranslation, /still requires workspace\.write\/patch and approval/);
  assert.doesNotMatch(workspaceTranslation, /[\u3400-\u9fff]/u);
  assert.match(workspaceTranslation, /after explicit human approval/);
  assert.match(workspaceTranslation, /Use artifact\.create/);
  assert.equal(translateUiText(artifactDescription, 'zh-CN'), artifactDescription);
  assert.equal(translateUiText(workspaceDescription, 'zh-CN'), workspaceDescription);
  assert.equal(translateUiText('自定义工具：' + workspaceDescription, 'en'), '自定义工具：' + workspaceDescription);
});
