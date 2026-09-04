import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { test } from 'node:test';
import PDFDocument from 'pdfkit';
import {
  attachmentDataUrl,
  attachmentPdfVisualPages,
  extractAttachmentText,
} from './attachmentContent.js';

const crc32 = (bytes: Uint8Array) => {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb8_8320 : 0);
  }
  return (crc ^ 0xffff_ffff) >>> 0;
};

const pngChunk = (type: string, data: Buffer) => {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])));
  return Buffer.concat([length, typeBytes, data, checksum]);
};

const solidPng = (red: number, green: number, blue: number, width = 24, height = 16) => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const scanlines = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      scanlines[offset] = red;
      scanlines[offset + 1] = green;
      scanlines[offset + 2] = blue;
    }
  }
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
};

const pdfBuffer = (write: (document: PDFKit.PDFDocument) => void) => new Promise<Buffer>((resolvePdf, rejectPdf) => {
  const document = new PDFDocument({ autoFirstPage: false, compress: false, margin: 0 });
  const chunks: Buffer[] = [];
  document.on('data', (chunk: Buffer) => chunks.push(chunk));
  document.once('end', () => resolvePdf(Buffer.concat(chunks)));
  document.once('error', rejectPdf);
  write(document);
  document.end();
});

test('image-only PDF renders the first two pages with stable page locators', async () => {
  const scannedPdf = await pdfBuffer((document) => {
    for (const color of [[210, 48, 64], [40, 178, 112], [50, 102, 220]] as const) {
      document.addPage({ size: [320, 180], margin: 0 });
      document.image(solidPng(color[0], color[1], color[2]), 0, 0, { width: 320, height: 180 });
    }
  });
  const attachment = {
    name: 'three-page-scan.pdf',
    mimeType: 'application/pdf',
    dataUrl: attachmentDataUrl(scannedPdf, 'application/pdf'),
  };

  const extractedText = await extractAttachmentText(attachment);
  assert.ok(extractedText.replace(/--- 第 .*?页 \/ .*?页 ---/g, '').trim().length < 120);
  const parts = await attachmentPdfVisualPages(attachment, extractedText);
  assert.equal(parts.length, 4);
  assert.deepEqual(parts.filter((part) => part.type === 'text').map((part) => part.text), [
    '[附件第 1 页已转为图片，交给视觉模型分析]',
    '[附件第 2 页已转为图片，交给视觉模型分析]',
  ]);
  const images = parts.filter((part) => part.type === 'image_url');
  assert.equal(images.length, 2);
  assert.ok(images.every((part) => part.image_url.url.startsWith('data:image/png;base64,')));
  assert.notEqual(images[0].image_url.url, images[1].image_url.url, 'Page order must preserve distinct page images.');
  for (const image of images) {
    const bytes = Buffer.from(image.image_url.url.split(',')[1], 'base64');
    assert.equal(bytes.subarray(1, 4).toString('ascii'), 'PNG');
    assert.ok(bytes.readUInt32BE(16) > 0 && bytes.readUInt32BE(16) <= 1_200);
  }
});

test('text PDF preserves page boundaries and bypasses visual fallback', async () => {
  const pageOne = `PAGE_ONE_REFERENCE ${'first page searchable content '.repeat(8)}`;
  const pageTwo = `PAGE_TWO_REFERENCE ${'second page searchable content '.repeat(8)}`;
  const textPdf = await pdfBuffer((document) => {
    document.addPage({ size: 'A4', margin: 48 }).fontSize(13).text(pageOne);
    document.addPage({ size: 'A4', margin: 48 }).fontSize(13).text(pageTwo);
  });
  const attachment = {
    name: 'two-page-text.pdf',
    mimeType: 'application/pdf',
    dataUrl: attachmentDataUrl(textPdf, 'application/pdf'),
  };

  const extractedText = await extractAttachmentText(attachment);
  assert.match(extractedText, /PAGE_ONE_REFERENCE/);
  assert.match(extractedText, /--- 第 1 页 \/ 2 页 ---/);
  assert.match(extractedText, /PAGE_TWO_REFERENCE/);
  assert.deepEqual(await attachmentPdfVisualPages(attachment, extractedText), []);
});
