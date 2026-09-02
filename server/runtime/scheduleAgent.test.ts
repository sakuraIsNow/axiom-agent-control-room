import assert from 'node:assert/strict';
import test from 'node:test';
import { fallbackScheduleDraft, parseScheduleDraft } from './scheduleAgent.js';

test('schedule Agent parser accepts a strict structured draft', () => {
  const draft = parseScheduleDraft('```json\n{"title":"行业简报","input":"搜索最新 Agent 行业动态并整理 5 条摘要","mode":"analyze","schedule":{"kind":"daily","timeOfDay":"09:00","timezone":"Asia/Shanghai"},"agentPolicy":"auto","reason":"每天重新检索并自动编排"}\n```');
  assert.equal(draft.schedule.kind, 'daily');
  assert.equal(draft.agentPolicy, 'auto');
});

test('deterministic fallback handles a daily Chinese expression and marks auto orchestration', () => {
  const draft = fallbackScheduleDraft('每天早上9点搜索 Agent 行业动态，整理成 5 条摘要');
  assert.ok(draft);
  assert.deepEqual(draft.schedule, { kind: 'daily', timeOfDay: '09:00', timezone: 'Asia/Shanghai' });
  assert.equal(draft.agentPolicy, 'auto');
});

test('deterministic fallback handles weekdays without inventing a fixed Agent', () => {
  const draft = fallbackScheduleDraft('每周一至五下午6点整理当天项目进展');
  assert.ok(draft);
  assert.deepEqual(draft.schedule, { kind: 'weekly', weekdays: [1, 2, 3, 4, 5], timeOfDay: '18:00', timezone: 'Asia/Shanghai' });
  assert.equal('agentId' in draft, false);
});

test('ambiguous timing is not silently invented by the fallback', () => {
  assert.equal(fallbackScheduleDraft('以后定期帮我整理行业新闻'), null);
});
