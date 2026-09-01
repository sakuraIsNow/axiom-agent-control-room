import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import { reportMarkdownToDocx, reportMarkdownToLatex, reportMarkdownToPdf } from '../server/runtime/reportExport.js';

const outputDirectory = resolve(process.cwd(), '.data', 'report-export-qa');
const markdown = `# 水库智能化研究报告

## 结论

建议按“省级平台、市县统筹、单库实施”三层推进，并为不确定成本保留复核条件。

| 能力 | 成熟度 | 应用建议 |
| --- | --- | --- |
| 在线监测 | 高 | 优先覆盖高风险水库 |
| 数字孪生 | 中高 | 先做数据治理与模型校准 |
| AI 预警 | 中 | 保留人工复核闭环 |

## 实施步骤

1. 盘点传感器、通信和历史数据
2. 建设统一数据底座与设备接入层
3. 试点预警模型并开展误报评估

> 成熟度是基于现有证据的工程判断，不等同于验收结论。

## 来源与限制

保留来源链接：[示例来源](https://example.com/source)。成本预算按 10% 运维比例测算，正式报价需现场核验。`;

await mkdir(outputDirectory, { recursive: true });
const docx = await reportMarkdownToDocx(markdown, '水库智能化研究报告');
const pdf = await reportMarkdownToPdf(markdown, '水库智能化研究报告');
const latex = reportMarkdownToLatex(markdown, '水库智能化研究报告');
await Promise.all([
  writeFile(resolve(outputDirectory, 'report-sample.md'), markdown, 'utf8'),
  writeFile(resolve(outputDirectory, 'report-sample.docx'), docx),
  writeFile(resolve(outputDirectory, 'report-sample.pdf'), pdf),
  writeFile(resolve(outputDirectory, 'report-sample.tex'), latex, 'utf8'),
]);

const wordText = await mammoth.extractRawText({ buffer: docx });
assert.match(wordText.value, /水库智能化研究报告/);
assert.match(wordText.value, /数字孪生/);
const parser = new PDFParse({ data: pdf });
try {
  const pdfText = await parser.getText();
  assert.match(pdfText.text, /水库智能化研究报告/);
  assert.match(pdfText.text, /数字孪生/);
} finally {
  await parser.destroy();
}
assert.match(latex, /10\\%/);
console.log(JSON.stringify({ outputDirectory, docxBytes: docx.byteLength, pdfBytes: pdf.byteLength, formats: ['md', 'docx', 'tex', 'pdf'] }, null, 2));
