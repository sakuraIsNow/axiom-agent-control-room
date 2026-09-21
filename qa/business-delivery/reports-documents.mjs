import assert from 'node:assert/strict';
import PDFDocument from 'pdfkit';
import mammoth from 'mammoth';
import { Document, Packer, Paragraph } from 'docx';
import { attachmentDataUrl, extractAttachmentText } from '../../server/runtime/attachmentContent.ts';
import { FixtureModel, delivered, digest, evidence, headers, principal, response, taskModel } from './helpers.mjs';

const facts = Object.freeze({ source: 'https://fixture.invalid/budget-2026', title: 'Approved Budget', implementation: 3200, review: 900, operations: 600, total: 4700 });
const report = '# Approved Budget\n\n| Item | Amount |\n| --- | --- |\n| Implementation | 3200 |\n| Review | 900 |\n| Operations | 600 |\n| Total | 4700 |\n\n[Approved source](https://fixture.invalid/budget-2026)\n\nNo external verification was performed.';
const reportOracle = (text) => ({ totalPresent: /\b4700\b/.test(text), sourcePresent: text.includes(facts.source), noUnsupportedClaims: !text.includes('independently verified'),
  sectionsPresent: ['Implementation', 'Review', 'Operations'].every((value) => text.includes(value)) });

async function exported(f, format, output = report) {
  const session = { id: 'source-report', title: facts.title, updatedAt: Date.now(), messages: [
    { id: 'u1', role: 'user', content: `Use only this supplied source: ${JSON.stringify(facts)}`, createdAt: 1 },
    { id: 'a1', role: 'assistant', content: report, createdAt: 2 },
  ] };
  await f.store.upsertSession(principal.tenantId, principal.userId, session);
  const model = f.register(new FixtureModel((request) => {
    assert.ok(request.user.includes('4700') && request.user.includes(facts.source), 'report must receive owned source material');
    return output;
  }));
  const result = await f.api({ reportModelFactory: async () => model }).request('/reports/export', {
    method: 'POST', headers, body: JSON.stringify({ sessionId: session.id, format, scope: 'conversation', instruction: 'Export the complete budget and source without adding claims.' }),
  });
  assert.equal(result.status, 200);
  assert.ok(result.headers.get('content-disposition').includes(`.${format}`));
  return { bytes: Buffer.from(await result.arrayBuffer()), mime: result.headers.get('content-type') };
}

const reportCase = (format) => ({ id: `report-${format}-download`, domain: 'source-report', expected: 'accepted-delivery', async run(f) {
  const result = await exported(f, format);
  const mime = result.mime.split(';')[0];
  const text = await extractAttachmentText({ name: `budget.${format}`, mimeType: mime, dataUrl: attachmentDataUrl(result.bytes, mime) });
  // Word plain-text extraction intentionally drops hyperlink targets; inspect the
  // actual document hyperlink conversion in addition to its readable content.
  const links = format === 'docx' ? (await mammoth.convertToHtml({ buffer: result.bytes })).value : '';
  const checks = reportOracle(`${text}\n${links}`);
  assert.ok(Object.values(checks).every(Boolean), JSON.stringify({ checks, text }));
  if (format === 'docx') assert.equal(result.bytes.subarray(0, 2).toString(), 'PK');
  if (format === 'pdf') assert.equal(result.bytes.subarray(0, 5).toString(), '%PDF-');
  return evidence(f, { checks, byteLength: result.bytes.length, sha256: digest(result.bytes), extractedText: text });
} });

async function analyzed(f, extracted, expected, mustContain) {
  assert.ok(mustContain.every((part) => extracted.includes(part)), 'attachment parser must preserve business facts before inference');
  const model = new FixtureModel((request) => {
    if (request.system.includes('You are the synthesizer')) return expected;
    assert.ok(mustContain.every((part) => request.user.includes(part)), 'extracted attachment text must reach execution');
    return response(expected);
  });
  const task = await f.create(`Analyze the supplied document only.\n${extracted}`);
  await delivered(f, task, model, expected);
  return evidence(f, { extractedText: extracted, deliveredText: expected, sha256: digest(extracted) });
}

export const reportDocumentCases = [
  reportCase('md'), reportCase('docx'), reportCase('pdf'),
  { id: 'report-wrong-source-rejected-by-oracle', domain: 'source-report', expected: 'oracle-rejects-injected-defect', async run(f) {
    const wrong = report.replace(facts.source, 'https://fixture.invalid/unrelated');
    const result = await exported(f, 'md', wrong);
    const checks = reportOracle(result.bytes.toString('utf8'));
    assert.equal(checks.sourcePresent, false, 'fixture oracle must detect a wrong exported citation');
    assert.equal(Object.values(checks).every(Boolean), false);
    return evidence(f, { checks, oracleAccepted: false, runtimeAutomaticallyBlocked: false, deliveredText: result.bytes.toString('utf8'),
      limitation: 'Exports are not a factual verification engine. This acceptance oracle detects the seeded defect; runtime does not automatically block it.' });
  } },
  { id: 'document-markdown-latest-budget', domain: 'attachment-analysis', expected: 'accepted-delivery', async run(f) {
    const text = '# Revised budget\nImplementation: 3200\nReview: 900\nOperations: 600\nLatest change: remove Review.\n';
    const extracted = await extractAttachmentText({ name: 'budget.md', mimeType: 'text/markdown', dataUrl: attachmentDataUrl(Buffer.from(text), 'text/markdown') });
    return analyzed(f, extracted, 'Revised total: 3800. Review is excluded; implementation and operations remain.', ['3200', '900', '600', 'remove Review']);
  } },
  { id: 'document-word-preserves-requirements', domain: 'attachment-analysis', expected: 'accepted-delivery', async run(f) {
    const bytes = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph('Release requirements'), new Paragraph('KEEP: offline export'), new Paragraph('REMOVE: public sharing'), new Paragraph('DEADLINE: 2026-10-01')] }] }));
    const extracted = await extractAttachmentText({ name: 'requirements.docx', dataUrl: attachmentDataUrl(bytes, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') });
    return analyzed(f, extracted, 'Deliver offline export by 2026-10-01. Public sharing is excluded.', ['offline export', 'REMOVE: public sharing', '2026-10-01']);
  } },
  { id: 'document-pdf-preserves-pages', domain: 'attachment-analysis', expected: 'accepted-delivery', async run(f) {
    const bytes = await new Promise((resolvePdf, reject) => {
      const document = new PDFDocument({ autoFirstPage: false });
      const chunks = [];
      document.on('data', (chunk) => chunks.push(chunk)); document.once('end', () => resolvePdf(Buffer.concat(chunks))); document.once('error', reject);
      document.addPage().text('PAGE_A: retention is 30 days.');
      document.addPage().text('PAGE_B: latest approved retention is 14 days; PAGE_A is superseded.'); document.end();
    });
    const extracted = await extractAttachmentText({ name: 'retention.pdf', mimeType: 'application/pdf', dataUrl: attachmentDataUrl(bytes, 'application/pdf') });
    assert.match(extracted, /--- 第 1 页 \/ 2 页 ---/);
    assert.match(extracted, /--- 第 2 页 \/ 2 页 ---/);
    return analyzed(f, extracted, 'Retention is 14 days, based on PAGE_B. The 30-day value in PAGE_A is superseded.', ['PAGE_A', 'PAGE_B', '14 days', '30 days']);
  } },
  { id: 'document-corrupt-word-not-fabricated', domain: 'attachment-analysis', expected: 'invalid-input-observed', async run(f) {
    const extracted = await extractAttachmentText({ name: 'broken.docx', dataUrl: attachmentDataUrl(Buffer.from('not a Word archive'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') });
    assert.equal(extracted, '', 'failed extraction must not become invented document text');
    return evidence(f, { extractedText: extracted, documentParserAccepted: false, scope: 'Attachment parser rejection only; upload UI failure messaging is covered separately.' });
  } },
];
