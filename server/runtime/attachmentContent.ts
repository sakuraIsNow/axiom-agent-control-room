import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';
import WordExtractor from 'word-extractor';

export type AttachmentContentInput = {
  dataUrl?: string;
  name?: string;
  mimeType?: string;
  text?: string;
};

export type AttachmentVisualPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export const decodeAttachmentDataUrl = (dataUrl: string | undefined) => {
  const match = dataUrl?.match(/^data:([^;,]+);base64,(.+)$/s);
  if (!match) return null;
  const bytes = Buffer.from(match[2], 'base64');
  return bytes.byteLength ? { mimeType: match[1], bytes } : null;
};

export const attachmentDataUrl = (bytes: Uint8Array, mimeType: string) =>
  `data:${mimeType};base64,${Buffer.from(bytes).toString('base64')}`;

export const extractAttachmentText = async (attachment: AttachmentContentInput) => {
  if (typeof attachment.text === 'string' && attachment.text.trim()) return attachment.text.trim().slice(0, 120_000);
  if (!attachment.dataUrl || !attachment.name) return '';
  const decoded = decodeAttachmentDataUrl(attachment.dataUrl);
  if (!decoded) return '';
  const { bytes } = decoded;
  if (/\.pdf$/i.test(attachment.name) || attachment.mimeType === 'application/pdf') {
    let parser: PDFParse | undefined;
    try {
      parser = new PDFParse({ data: bytes });
      const result = await parser.getText({
        parseHyperlinks: true,
        cellSeparator: ' | ',
        pageJoiner: '\n\n--- 第 page_number 页 / total_number 页 ---\n\n',
      });
      let text = result.text.trim();
      try {
        const tables = await parser.getTable({ first: Math.min(result.total, 12) });
        const tableContext = tables.pages.flatMap((page) => page.tables.map((table, index) => [
          `\n[第 ${page.num} 页表格 ${index + 1}]`,
          table.map((row) => `| ${row.map((cell) => cell.replaceAll('|', '\\|').replace(/\s+/g, ' ').trim()).join(' | ')} |`).join('\n'),
        ].join('\n'))).join('\n');
        if (tableContext) text = `${text}\n\n${tableContext}`;
      } catch {
        // Some PDFs do not contain vector table lines; text remains usable.
      }
      return text.slice(0, 120_000);
    } catch {
      const source = bytes.toString('latin1');
      const literals = [...source.matchAll(/\(([^()]{2,240})\)/g)].map((match) => match[1]);
      return literals.join(' ').replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').slice(0, 120_000);
    } finally {
      await parser?.destroy().catch(() => undefined);
    }
  }
  if (/\.(txt|md|markdown|csv|json|log|xml|html|svg)$/i.test(attachment.name)
    || /^(?:text\/|application\/(?:json|xml))/i.test(attachment.mimeType ?? '')) {
    return bytes.toString('utf8').slice(0, 120_000);
  }
  if (/\.(doc|docx)$/i.test(attachment.name)) {
    try {
      if (/\.doc$/i.test(attachment.name)) {
        const document = await new WordExtractor().extract(bytes);
        return document.getBody().trim().slice(0, 120_000);
      }
      const result = await mammoth.extractRawText({ buffer: bytes });
      return result.value.trim().slice(0, 120_000);
    } catch {
      return '';
    }
  }
  return '';
};

export const attachmentPdfVisualPages = async (
  attachment: AttachmentContentInput,
  extractedText: string,
): Promise<AttachmentVisualPart[]> => {
  if (!attachment.dataUrl || !attachment.name || !/\.pdf$/i.test(attachment.name)
    || extractedText.replace(/--- 第 .*?页 \/ .*?页 ---/g, '').trim().length >= 120) return [];
  const decoded = decodeAttachmentDataUrl(attachment.dataUrl);
  if (!decoded) return [];
  let parser: PDFParse | undefined;
  try {
    parser = new PDFParse({ data: decoded.bytes });
    const screenshots = await parser.getScreenshot({ first: 2, desiredWidth: 1200, imageDataUrl: true, imageBuffer: false });
    return screenshots.pages.flatMap((page) => page.dataUrl
      ? [{ type: 'text' as const, text: `[附件第 ${page.pageNumber} 页已转为图片，交给视觉模型分析]` }, { type: 'image_url' as const, image_url: { url: page.dataUrl } }]
      : []);
  } catch {
    return [];
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
};
