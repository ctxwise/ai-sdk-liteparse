// Runs LiteParse for real on the fixtures; no network, no model calls.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import type { LanguageModelV4CallOptions, LanguageModelV4Prompt } from '@ai-sdk/provider';
import { FileType, type LiteparseAttachmentsOptions, liteparseAttachments } from '../src/index.ts';

const fixture = (name: string) => readFileSync(new URL(`fixtures/${name}`, import.meta.url));

/** what the model receives for one attached file */
async function sent(data: Buffer, mediaType: string, options: LiteparseAttachmentsOptions = {}) {
  const prompt: LanguageModelV4Prompt = [
    { role: 'user', content: [{ type: 'file', mediaType, filename: 'f', data: { type: 'data', data } }] },
  ];
  const middleware = liteparseAttachments({ onError: () => {}, ...options });
  const params = await middleware.transformParams!({
    type: 'generate',
    params: { prompt } as LanguageModelV4CallOptions,
    model: {} as never,
  });
  return params.prompt[0].content as { type: string; text?: string; mediaType?: string }[];
}
const textOf = (parts: { text?: string }[]) => parts.map((p) => p.text ?? '').join('\n');
const images = (parts: { type: string }[]) => parts.filter((p) => p.type === 'file').length;

test('clean scan: OCR is confident, the model gets text only', async () => {
  const parts = await sent(fixture('scan.pdf'), FileType.PDF);
  assert.match(textOf(parts), /Alan Turing/);
  assert.equal(images(parts), 0);
});

test('handwriting: OCR is not confident, the image goes to the model', async () => {
  const parts = await sent(fixture('handwritten.jpg'), FileType.JPEG);
  assert.deepEqual(
    parts.map((p) => p.mediaType ?? 'text'),
    ['text', FileType.JPEG, 'text'],
  );
});

test('mixed pdf: native text page stays text, handwritten page becomes a page image', async () => {
  const parts = await sent(fixture('mixed.pdf'), FileType.PDF);
  assert.match(textOf(parts), /Docling delivers today/);
  assert.equal(parts.filter((p) => p.mediaType === FileType.PNG).length, 1);
});

test('minConfidence 0 keeps OCR text even when it is poor', async () => {
  assert.equal(images(await sent(fixture('handwritten.jpg'), FileType.JPEG, { minConfidence: 0 })), 0);
});

// Office needs LibreOffice: runs in the Docker image, skipped on machines without it
const noLibreOffice = spawnSync('soffice', ['--version']).status !== 0 && 'LibreOffice not installed';

test('office: docx text and its photo', { skip: noLibreOffice }, async () => {
  const parts = await sent(fixture('report.docx'), FileType.DOCX);
  assert.match(textOf(parts), /Revenue grew 12% to 4\.2M/);
});

test('office: xlsx becomes a markdown table', { skip: noLibreOffice }, async () => {
  assert.match(textOf(await sent(fixture('sales.xlsx'), FileType.XLSX)), /^\|.*\|$/m);
});

test('office: a slide read by page OCR keeps its photo', { skip: noLibreOffice }, async () => {
  // regression: the slide's title OCR'd confidently and the photo was dropped
  const parts = await sent(fixture('deck.pptx'), FileType.PPTX);
  assert.match(textOf(parts), /Team/);
  assert.equal(images(parts), 1);
});

test("ocr engine 'server': OCR comes from the server at <serverUrl>/ocr", async () => {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? '');
    req.resume().on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ results: [{ text: 'FROM-SERVER', bbox: [10, 10, 300, 40], confidence: 0.99 }] }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  try {
    const { port } = server.address() as AddressInfo;
    const ocr = { engine: 'server', serverUrl: `http://127.0.0.1:${port}` } as const;
    const parts = await sent(fixture('handwritten.jpg'), FileType.JPEG, { ocr });
    assert.match(textOf(parts), /FROM-SERVER/);
    assert.ok(paths.length && paths.every((p) => p === '/ocr'), paths.join());
  } finally {
    server.close();
  }
});

test("ocr engine 'none': native text stays text, every image goes to the model", async () => {
  const ocr = { engine: 'none' } as const;
  const mixed = await sent(fixture('mixed.pdf'), FileType.PDF, { ocr });
  assert.match(textOf(mixed), /Docling delivers today/);
  assert.equal(images(mixed), 1, 'the handwritten page, as an image');
  const scan = await sent(fixture('scan.pdf'), FileType.PDF, { ocr });
  assert.equal(images(scan), 2, 'both scanned pages, not OCR text');
  assert.doesNotMatch(textOf(scan), /Alan Turing/);
});

test("ocr engine 'server' without a url fails at setup", () => {
  assert.throws(() => liteparseAttachments({ ocr: { engine: 'server' } }), /needs `serverUrl`/);
});

test('plain text is read as-is and cut with a note', async () => {
  const parts = await sent(Buffer.from('hello world'), 'text/markdown', { maxTextChars: 5 });
  assert.match(textOf(parts), /hello\n\[cut after 5 characters; the file continues\]/);
});

test('unsupported type: a note, not an error', async () => {
  const parts = await sent(Buffer.from('x'), 'video/mp4');
  assert.match(textOf(parts), /\[attachment "f": this file type \(video\/mp4\) can't be read\]/);
});
