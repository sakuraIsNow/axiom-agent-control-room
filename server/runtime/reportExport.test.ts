import assert from 'node:assert/strict';
import { test } from 'node:test';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import type { PersistedSession } from './contracts.js';
import type { ModelClient, ModelCompletionRequest } from './modelClient.js';
import { generateReport, reportMarkdownToLatex } from './reportExport.js';

class ReportModel implements ModelClient {
  readonly model = 'report-test-model';
  calls: ModelCompletionRequest[] = [];
  async complete(request: ModelCompletionRequest) {
    this.calls.push(request);
    return {
      content: `# 水库智能化评估报告

## 执行摘要

现有证据支持分层实施，仍需核验现场条件。

| 技术 | 成熟度 | 依据 |
| --- | --- | --- |
| 数字孪生 | 较高 | [公开来源](https://example.com/source) |

- 先完成监测设备盘点
- 再进行平台集成

## 风险

成本区间含 10% 运维预算，不能写成固定报价。`,
      attempts: 1,
      durationMs: 1,
      finishReason: 'stop',
    };
  }
}

const session: PersistedSession = {
  id: 'report-session',
  tenantId: 'tenant-a',
  userId: 'user-a',
  title: '水库智能化研究',
  updatedAt: Date.now(),
  messages: [
    { id: 'u1', role: 'user', content: '研究水库智能化技术。', createdAt: 1 },
    { id: 'a1', role: 'assistant', content: '已有分析与来源 https://example.com/source', createdAt: 2 },
  ],
};

test('Report Agent creates readable Markdown, DOCX, LaTeX, and PDF files', async () => {
  const signal = new AbortController().signal;
  const markdown = await generateReport(new ReportModel(), session, { scope: 'last-answer', format: 'md', instruction: '导出以上回答为 Markdown' }, signal);
  assert.match(markdown.bytes.toString('utf8'), /^# 水库智能化评估报告/);
  assert.equal(markdown.mimeType, 'text/markdown; charset=utf-8');

  const docx = await generateReport(new ReportModel(), session, { scope: 'conversation', format: 'docx', instruction: '把整个对话导出 Word' }, signal);
  assert.equal(docx.bytes.subarray(0, 2).toString(), 'PK');
  const wordText = await mammoth.extractRawText({ buffer: docx.bytes });
  assert.match(wordText.value, /水库智能化评估报告/);
  assert.match(wordText.value, /数字孪生/);

  const tex = await generateReport(new ReportModel(), session, { scope: 'last-answer', format: 'tex', instruction: '导出 LaTeX' }, signal);
  assert.match(tex.bytes.toString('utf8'), /\\documentclass/);
  assert.match(tex.bytes.toString('utf8'), /10\\%/);

  const pdf = await generateReport(new ReportModel(), session, { scope: 'last-answer', format: 'pdf', instruction: '导出 PDF' }, signal);
  assert.equal(pdf.bytes.subarray(0, 5).toString(), '%PDF-');
  const parser = new PDFParse({ data: pdf.bytes });
  try {
    const result = await parser.getText();
    assert.match(result.text, /水库智能化评估报告/);
    assert.match(result.text, /数字孪生/);
  } finally {
    await parser.destroy();
  }
});

test('LaTeX export escapes user-visible special characters', () => {
  const latex = reportMarkdownToLatex('# 标题\n\n成本 10% & 风险_项 #1', '测试_报告');
  assert.match(latex, /测试\\_报告/);
  assert.match(latex, /10\\% \\& 风险\\_项 \\#1/);
});

test('last-answer export fails clearly when a session has no Agent answer', async () => {
  const empty: PersistedSession = { ...session, messages: [{ id: 'u', role: 'user', content: '只有问题', createdAt: 1 }] };
  await assert.rejects(
    generateReport(new ReportModel(), empty, { scope: 'last-answer', format: 'md', instruction: '导出以上回答' }, new AbortController().signal),
    /还没有可导出/,
  );
});
