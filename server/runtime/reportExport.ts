import { fileURLToPath } from 'node:url';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import PDFDocument from 'pdfkit';
import type { ModelClient } from './modelClient.js';
import type { PersistedSession, PersistedSessionMessage } from './contracts.js';

export type ReportFormat = 'md' | 'docx' | 'tex' | 'pdf';
export type ReportScope = 'last-answer' | 'conversation';

export type ReportExportRequest = {
  format: ReportFormat;
  scope: ReportScope;
  instruction: string;
  title?: string;
};

export type GeneratedReport = {
  bytes: Buffer;
  fileName: string;
  mimeType: string;
  markdown: string;
  title: string;
};

type ReportBlock =
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'rule' };

const reportMimeTypes: Record<ReportFormat, string> = {
  md: 'text/markdown; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  tex: 'application/x-tex; charset=utf-8',
  pdf: 'application/pdf',
};

const reportExtensions: Record<ReportFormat, string> = { md: 'md', docx: 'docx', tex: 'tex', pdf: 'pdf' };
const outputLimitReasons = new Set(['length', 'max_tokens', 'token_limit']);
const cleanText = (value: string) => value.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();
const safeTitle = (value: string) => cleanText(value).replace(/^#+\s*/, '').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').slice(0, 80).trim() || 'Axiom 报告';
const stripInlineMarkdown = (value: string) => value
  .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/__([^_]+)__/g, '$1')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
  .replace(/~~([^~]+)~~/g, '$1')
  .replace(/\*+/g, '');

const splitTableRow = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cleanText(cell));
const isTableDivider = (line: string) => /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);

export const parseReportMarkdown = (markdown: string): ReportBlock[] => {
  const lines = cleanText(markdown).split('\n');
  const blocks: ReportBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }
    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```/.test((lines[index] ?? '').trim())) code.push(lines[index++] ?? '');
      index += index < lines.length ? 1 : 0;
      blocks.push({ kind: 'code', language, text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line.trim());
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1]!.length, text: heading[2]!.trim() });
      index += 1;
      continue;
    }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      index += 1;
      continue;
    }
    if (index + 1 < lines.length && line.includes('|') && isTableDivider(lines[index + 1] ?? '')) {
      const rows = [splitTableRow(line)];
      index += 2;
      while (index < lines.length && (lines[index] ?? '').includes('|') && (lines[index] ?? '').trim()) rows.push(splitTableRow(lines[index++] ?? ''));
      blocks.push({ kind: 'table', rows });
      continue;
    }
    const listMatch = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = Boolean(listMatch[1]);
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s*(?:(\d+)[.)]|[-*+])\s+(.+)$/.exec(lines[index] ?? '');
        if (!item || Boolean(item[1]) !== ordered) break;
        items.push(item[2]!.trim());
        index += 1;
      }
      blocks.push({ kind: 'list', ordered, items });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index] ?? '')) quote.push((lines[index++] ?? '').replace(/^\s*>\s?/, ''));
      blocks.push({ kind: 'quote', text: quote.join(' ') });
      continue;
    }
    const paragraph = [line.trim()];
    index += 1;
    while (index < lines.length) {
      const next = lines[index] ?? '';
      if (!next.trim() || /^(#{1,6})\s+/.test(next.trim()) || /^```/.test(next.trim()) || /^\s*(?:(?:\d+)[.)]|[-*+])\s+/.test(next) || /^\s*>/.test(next)) break;
      if (index + 1 < lines.length && next.includes('|') && isTableDivider(lines[index + 1] ?? '')) break;
      paragraph.push(next.trim());
      index += 1;
    }
    blocks.push({ kind: 'paragraph', text: paragraph.join(' ') });
  }
  return blocks;
};

const markdownTitle = (markdown: string, fallback: string) => {
  const match = /^#\s+(.+)$/m.exec(markdown);
  return safeTitle(match?.[1] ?? fallback);
};

const reportMessages = (session: PersistedSession, scope: ReportScope, instruction: string) => {
  const messages = session.messages.filter((message) => !message.pending && message.content.trim());
  if (scope === 'last-answer') {
    const lastAnswer = [...messages].reverse().find((message) => message.role === 'assistant');
    if (!lastAnswer) throw new Error('当前会话还没有可导出的 Agent 回答。');
    return [lastAnswer];
  }
  const normalizedInstruction = instruction.trim();
  return messages.filter((message, index) => !(index === messages.length - 1 && message.role === 'user' && message.content.trim() === normalizedInstruction));
};

const renderConversation = (messages: PersistedSessionMessage[]) => messages.map((message, index) => (
  `### ${index + 1}. ${message.role === 'user' ? '用户' : 'Agent'}\n${message.content.trim()}`
)).join('\n\n');

const chunkText = (value: string, maxCharacters = 24_000) => {
  if (value.length <= maxCharacters) return [value];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length) {
    let boundary = Math.min(maxCharacters, remaining.length);
    if (boundary < remaining.length) {
      const paragraph = remaining.lastIndexOf('\n\n', boundary);
      if (paragraph >= Math.floor(maxCharacters * 0.6)) boundary = paragraph;
    }
    chunks.push(remaining.slice(0, boundary));
    remaining = remaining.slice(boundary).trimStart();
  }
  return chunks.slice(0, 20);
};

const mergeContinuation = (previous: string, continuation: string) => {
  const next = continuation.trimStart();
  if (!next) return previous;
  const maxOverlap = Math.min(previous.length, next.length, 8_000);
  for (let size = maxOverlap; size >= 80; size -= 1) {
    if (previous.endsWith(next.slice(0, size))) return previous + next.slice(size);
  }
  return `${previous}${previous.endsWith('\n') ? '' : '\n'}${next}`;
};

const completeMarkdown = async (model: ModelClient, system: string, user: string, signal: AbortSignal) => {
  let completion = await model.complete({ signal, system, user, temperature: 0.1, maxTokens: 8_192 });
  let output = completion.content.trim();
  for (let attempt = 0; outputLimitReasons.has((completion.finishReason ?? '').toLowerCase()) && attempt < 4; attempt += 1) {
    completion = await model.complete({
      signal,
      system: `${system}\nThe previous output reached the token limit. Continue without repeating any existing text.`,
      user: `已有报告末尾：\n${output.slice(-10_000)}\n\n请从中断处继续，只输出缺失内容。`,
      temperature: 0.1,
      maxTokens: 8_192,
    });
    output = mergeContinuation(output, completion.content);
  }
  if (!output) throw new Error('报告生成 Agent 没有返回可导出的内容。');
  if (outputLimitReasons.has((completion.finishReason ?? '').toLowerCase())) throw new Error('报告内容超过模型单次交付能力，续写后仍未完整结束。');
  return output.replace(/^```(?:markdown|md)?\s*/i, '').replace(/\s*```$/i, '').trim();
};

const generateReportMarkdown = async (
  model: ModelClient,
  session: PersistedSession,
  request: ReportExportRequest,
  signal: AbortSignal,
) => {
  const source = renderConversation(reportMessages(session, request.scope, request.instruction));
  const chunks = chunkText(source);
  const sourceForReport = chunks.length === 1
    ? chunks[0]!
    : (await Promise.all(chunks.map((chunk, index) => completeMarkdown(
      model,
      '你是报告生成 Agent 的上下文整理子程序。忠实压缩输入，不遗漏结论、数字、来源链接、风险、待办和不确定性；禁止补造事实。只输出 Markdown。',
      `这是完整会话的第 ${index + 1}/${chunks.length} 段。请形成可供最终报告引用的结构化摘要：\n\n${chunk}`,
      signal,
    )))).map((summary, index) => `## 会话分段 ${index + 1}\n${summary}`).join('\n\n');
  return completeMarkdown(
    model,
    `你是 Axiom 的报告生成 Agent。把会话中的现有信息整理成可以直接交付的正式报告，而不是继续回答用户的新问题。
严格遵守用户的导出要求和指定范围。保留有依据的结论、数据、表格、来源标题、URL、DOI、风险和待办；不得虚构来源或把推测写成事实。信息不足时明确标注。使用清晰的 Markdown 标题层级，首行必须是唯一的一级标题。不要输出“是否需要导出”等询问，不要添加 Markdown 代码围栏。`,
    `用户导出要求：${request.instruction}\n导出范围：${request.scope === 'conversation' ? '完整会话' : '最近一条 Agent 回答'}\n期望文件格式：${request.format}\n建议标题：${request.title || session.title}\n\n待整理内容：\n${sourceForReport}`,
    signal,
  );
};

const inlineDocx = (value: string) => {
  const children: Array<TextRun | ExternalHyperlink> = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > cursor) children.push(new TextRun({ text: value.slice(cursor, start), font: 'Microsoft YaHei', size: 22 }));
    const token = match[0];
    if (token.startsWith('**')) children.push(new TextRun({ text: token.slice(2, -2), bold: true, font: 'Microsoft YaHei', size: 22 }));
    else if (token.startsWith('`')) children.push(new TextRun({ text: token.slice(1, -1), font: 'Consolas', size: 20, shading: { fill: 'EEF2F3' } }));
    else {
      const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      if (link) children.push(new ExternalHyperlink({ link: link[2]!, children: [new TextRun({ text: link[1]!, color: '167D72', underline: {}, font: 'Microsoft YaHei', size: 22 })] }));
    }
    cursor = start + token.length;
  }
  if (cursor < value.length) children.push(new TextRun({ text: value.slice(cursor), font: 'Microsoft YaHei', size: 22 }));
  return children.length ? children : [new TextRun({ text: value, font: 'Microsoft YaHei', size: 22 })];
};

export const reportMarkdownToDocx = async (markdown: string, title: string) => {
  const headingLevels = [HeadingLevel.TITLE, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5];
  const children: Array<Paragraph | Table> = [];
  for (const block of parseReportMarkdown(markdown)) {
    if (block.kind === 'heading') {
      children.push(new Paragraph({
        heading: headingLevels[Math.min(5, Math.max(0, block.level - 1))],
        children: [new TextRun({ text: stripInlineMarkdown(block.text), bold: true, color: block.level === 1 ? '102F2B' : '153E38', font: 'Microsoft YaHei' })],
        spacing: { before: block.level === 1 ? 0 : 260, after: 120 },
      }));
    } else if (block.kind === 'paragraph') {
      children.push(new Paragraph({ children: inlineDocx(block.text), spacing: { after: 150, line: 340 } }));
    } else if (block.kind === 'quote') {
      children.push(new Paragraph({ children: [new TextRun({ text: stripInlineMarkdown(block.text), italics: true, color: '49635F', font: 'Microsoft YaHei', size: 21 })], indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, color: '2BBF9F', size: 12, space: 10 } }, spacing: { after: 160 } }));
    } else if (block.kind === 'list') {
      block.items.forEach((item, index) => children.push(new Paragraph({ children: inlineDocx(`${block.ordered ? `${index + 1}.` : '•'} ${item}`), indent: { left: 360, hanging: 220 }, spacing: { after: 80 } })));
    } else if (block.kind === 'code') {
      children.push(new Paragraph({ children: [new TextRun({ text: block.text, font: 'Consolas', size: 18 })], shading: { fill: 'F1F4F5' }, spacing: { before: 80, after: 160 }, indent: { left: 180, right: 180 } }));
    } else if (block.kind === 'table') {
      const columnCount = Math.max(1, ...block.rows.map((row) => row.length));
      children.push(new Table({
        width: { size: 100, type: WidthType.PERCENTAGE },
        columnWidths: Array.from({ length: columnCount }, () => Math.floor(9_000 / columnCount)),
        rows: block.rows.map((row, rowIndex) => new TableRow({
          tableHeader: rowIndex === 0,
          children: Array.from({ length: columnCount }, (_, columnIndex) => new TableCell({
            width: { size: Math.floor(100 / columnCount), type: WidthType.PERCENTAGE },
            shading: rowIndex === 0 ? { fill: 'DDEBE8' } : undefined,
            children: [new Paragraph({ children: [new TextRun({ text: stripInlineMarkdown(row[columnIndex] ?? ''), bold: rowIndex === 0, font: 'Microsoft YaHei', size: 19 })], spacing: { before: 60, after: 60 } })],
          })),
        })),
      }));
      children.push(new Paragraph({ text: '', spacing: { after: 100 } }));
    } else if (block.kind === 'rule') {
      children.push(new Paragraph({ text: '', border: { bottom: { style: BorderStyle.SINGLE, color: 'A8BDB9', size: 4, space: 8 } }, spacing: { before: 80, after: 160 } }));
    }
  }
  const document = new Document({
    creator: 'Axiom Report Agent',
    title,
    description: '由 Axiom 报告生成 Agent 根据会话内容生成',
    styles: {
      default: { document: { run: { font: 'Microsoft YaHei', size: 22, color: '172522' }, paragraph: { spacing: { line: 340 } } } },
    },
    sections: [{
      properties: { page: { margin: { top: 1_080, right: 1_080, bottom: 1_080, left: 1_080 } } },
      children,
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Axiom · ', color: '6B7F7B', size: 18 }), new TextRun({ children: [PageNumber.CURRENT], color: '6B7F7B', size: 18 })] })] }) },
    }],
  });
  return Buffer.from(await Packer.toBuffer(document));
};

const pdfFontPath = fileURLToPath(new URL('../assets/noto-sans-sc-400.woff', import.meta.url));

export const reportMarkdownToPdf = async (markdown: string, title: string) => new Promise<Buffer>((resolve, reject) => {
  const document = new PDFDocument({ size: 'A4', margins: { top: 54, right: 54, bottom: 58, left: 54 }, info: { Title: title, Author: 'Axiom Report Agent', Creator: 'Axiom' }, bufferPages: true });
  const chunks: Buffer[] = [];
  document.on('data', (chunk: Buffer) => chunks.push(chunk));
  document.on('error', reject);
  document.on('end', () => resolve(Buffer.concat(chunks)));
  document.registerFont('AxiomCJK', pdfFontPath);
  document.font('AxiomCJK').fillColor('#172522');
  const leftMargin = document.page.margins.left;
  const usableWidth = document.page.width - document.page.margins.left - document.page.margins.right;
  const ensureSpace = (height: number) => { if (document.y + height > document.page.height - document.page.margins.bottom) document.addPage(); };
  for (const block of parseReportMarkdown(markdown)) {
    document.x = leftMargin;
    if (block.kind === 'heading') {
      const size = [26, 20, 16, 14, 12, 11][Math.min(5, block.level - 1)] ?? 11;
      ensureSpace(size * 2.2);
      document.moveDown(block.level === 1 ? 0 : 0.55).fontSize(size).fillColor(block.level === 1 ? '#0F3D35' : '#155D50').text(stripInlineMarkdown(block.text), { lineGap: 4 });
      document.moveDown(0.35);
    } else if (block.kind === 'paragraph') {
      document.fontSize(10.5).fillColor('#21312E').text(stripInlineMarkdown(block.text), { align: 'justify', lineGap: 5 });
      document.moveDown(0.55);
    } else if (block.kind === 'quote') {
      ensureSpace(52);
      const x = document.x;
      document.save().strokeColor('#2BBF9F').lineWidth(2).moveTo(x, document.y).lineTo(x, document.y + 36).stroke().restore();
      document.x = x + 12;
      document.fontSize(10).fillColor('#49635F').text(stripInlineMarkdown(block.text), { lineGap: 4 });
      document.x = x;
      document.moveDown(0.55);
    } else if (block.kind === 'list') {
      block.items.forEach((item, index) => document.fontSize(10.5).fillColor('#21312E').text(`${block.ordered ? `${index + 1}.` : '•'} ${stripInlineMarkdown(item)}`, { indent: 12, lineGap: 4 }));
      document.moveDown(0.45);
    } else if (block.kind === 'code') {
      const text = block.text || ' ';
      const height = Math.min(420, document.heightOfString(text, { width: usableWidth - 24, lineGap: 3 }) + 18);
      ensureSpace(height + 12);
      const y = document.y;
      document.save().roundedRect(document.x, y, usableWidth, height, 3).fill('#F0F4F3').restore();
      document.fontSize(8.5).fillColor('#24423D').text(text, document.x + 12, y + 9, { width: usableWidth - 24, height: height - 18, lineGap: 3 });
      document.y = y + height + 10;
    } else if (block.kind === 'table') {
      const columns = Math.max(1, ...block.rows.map((row) => row.length));
      const columnWidth = usableWidth / columns;
      for (let rowIndex = 0; rowIndex < block.rows.length; rowIndex += 1) {
        const row = block.rows[rowIndex]!;
        const heights = Array.from({ length: columns }, (_, columnIndex) => document.heightOfString(stripInlineMarkdown(row[columnIndex] ?? ''), { width: columnWidth - 12, lineGap: 2 }));
        const rowHeight = Math.max(28, ...heights) + 10;
        ensureSpace(rowHeight);
        const y = document.y;
        for (let columnIndex = 0; columnIndex < columns; columnIndex += 1) {
          const x = document.page.margins.left + columnIndex * columnWidth;
          document.save().rect(x, y, columnWidth, rowHeight).fillAndStroke(rowIndex === 0 ? '#DDEBE8' : '#FFFFFF', '#AFC3BF').restore();
          document.fontSize(8.5).fillColor('#20332F').text(stripInlineMarkdown(row[columnIndex] ?? ''), x + 6, y + 6, { width: columnWidth - 12, height: rowHeight - 12, lineGap: 2 });
        }
        document.x = leftMargin;
        document.y = y + rowHeight;
      }
      document.moveDown(0.65);
    } else {
      ensureSpace(18);
      document.moveDown(0.2).strokeColor('#A8BDB9').moveTo(document.x, document.y).lineTo(document.x + usableWidth, document.y).stroke().moveDown(0.7);
    }
  }
  document.end();
});

const latexEscape = (value: string) => value
  .replace(/\\/g, '\\textbackslash{}')
  .replace(/([#$%&_{}])/g, '\\$1')
  .replace(/~/g, '\\textasciitilde{}')
  .replace(/\^/g, '\\textasciicircum{}');

export const reportMarkdownToLatex = (markdown: string, title: string) => {
  const body: string[] = [];
  for (const block of parseReportMarkdown(markdown)) {
    if (block.kind === 'heading') {
      if (block.level === 1) continue;
      const command = ['section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'][Math.min(4, block.level - 2)] ?? 'paragraph';
      body.push(`\\${command}{${latexEscape(stripInlineMarkdown(block.text))}}`);
    } else if (block.kind === 'paragraph') body.push(`${latexEscape(stripInlineMarkdown(block.text))}\n`);
    else if (block.kind === 'quote') body.push(`\\begin{quote}\n${latexEscape(stripInlineMarkdown(block.text))}\n\\end{quote}`);
    else if (block.kind === 'list') body.push(`\\begin{${block.ordered ? 'enumerate' : 'itemize'}}\n${block.items.map((item) => `\\item ${latexEscape(stripInlineMarkdown(item))}`).join('\n')}\n\\end{${block.ordered ? 'enumerate' : 'itemize'}}`);
    else if (block.kind === 'code') body.push(`\\begin{verbatim}\n${block.text}\n\\end{verbatim}`);
    else if (block.kind === 'table') {
      const columns = Math.max(1, ...block.rows.map((row) => row.length));
      const columnWidth = (0.92 / columns).toFixed(3);
      const columnSpec = Array.from({ length: columns }, () => `p{${columnWidth}\\linewidth}`).join('|');
      body.push(`\\begin{longtable}{${columnSpec}}\n\\hline\n${block.rows.map((row) => `${Array.from({ length: columns }, (_, index) => latexEscape(stripInlineMarkdown(row[index] ?? ''))).join(' & ')} \\\\ \\hline`).join('\n')}\n\\end{longtable}`);
    } else body.push('\\par\\noindent\\rule{\\linewidth}{0.4pt}');
  }
  return `\\documentclass[11pt,a4paper]{article}
\\usepackage[margin=2.4cm]{geometry}
\\usepackage{fontspec}
\\usepackage{xeCJK}
\\usepackage{hyperref}
\\usepackage{tabularx}
\\usepackage{longtable}
\\usepackage{xcolor}
\\setCJKmainfont{Noto Sans CJK SC}
\\hypersetup{colorlinks=true,linkcolor=teal,urlcolor=teal}
\\title{${latexEscape(title)}}
\\author{Axiom Report Agent}
\\date{\\today}
\\begin{document}
\\maketitle
\\tableofcontents
\\newpage
${body.join('\n\n')}
\\end{document}
`;
};

export const generateReport = async (
  model: ModelClient,
  session: PersistedSession,
  request: ReportExportRequest,
  signal: AbortSignal,
): Promise<GeneratedReport> => {
  const markdown = await generateReportMarkdown(model, session, request, signal);
  const title = markdownTitle(markdown, request.title || session.title);
  const baseName = safeTitle(title);
  const bytes = request.format === 'md'
    ? Buffer.from(markdown, 'utf8')
    : request.format === 'tex'
      ? Buffer.from(reportMarkdownToLatex(markdown, title), 'utf8')
      : request.format === 'docx'
        ? await reportMarkdownToDocx(markdown, title)
        : await reportMarkdownToPdf(markdown, title);
  return {
    bytes,
    title,
    markdown,
    fileName: `${baseName}.${reportExtensions[request.format]}`,
    mimeType: reportMimeTypes[request.format],
  };
};
