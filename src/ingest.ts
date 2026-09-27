/**
 * One file -> AI SDK parts. The switch only answers "what kind of input is this?"; every raster (an uploaded
 * image, a picture inside a document, a scanned page) then goes through the same processImage():
 * OCR first, and the vision model only when OCR is not confident.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { cpus, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LanguageModelV4FilePart, LanguageModelV4TextPart } from '@ai-sdk/provider';
import {
  LiteParse,
  type LiteParseConfig,
  type ParsedPage,
  type PoolOptions,
  type TextItem,
} from '@llamaindex/liteparse';
import { generateText, type LanguageModel } from 'ai';
import { EXTENSIONS, FileType, isTextType, MODEL_TYPES } from './constants.ts';

export type Part = LanguageModelV4TextPart | LanguageModelV4FilePart;

export interface InputFile {
  bytes: Buffer;
  mediaType: string;
}

/**
 * OCR backend selection. Maps onto LiteParse config; the package stays pure TypeScript — an external
 * engine (RapidOCR, PaddleOCR, ...) is just an HTTP server at `serverUrl`, never a dependency here.
 */
export interface OcrOptions {
  /**
   * `tesseract` = LiteParse's built-in OCR; `server` = an external OCR server at `serverUrl`;
   * `none` = no OCR: native text and tables only, every picture and scanned page goes to the vision model.
   * @default 'tesseract'
   */
  engine?: 'tesseract' | 'server' | 'none';
  /** OCR server base url (`/ocr` is added) or full `.../ocr` url. Required when `engine: 'server'`. */
  serverUrl?: string;
  /** extra HTTP headers sent with every request to `serverUrl` (e.g. auth). */
  serverHeaders?: Record<string, string>;
  /** OCR language: a Tesseract code (`eng`, `deu`) for the built-in engine, ISO-639-1 (`en`) for servers. */
  language?: string;
  /** render DPI for scanned pages and OCR input; higher improves accuracy at a memory cost. */
  dpi?: number;
  /** concurrent OCR workers. @default min(4, CPU count) — avoids oversubscription on small (2 vCPU) boxes. */
  numWorkers?: number;
  /** path to a `tessdata` directory (built-in Tesseract engine only). */
  tessdataPath?: string;
}

export interface IngestOptions {
  /** OCR below this confidence (0-1) goes to the vision model. @default per engine, see MIN_CONFIDENCE */
  minConfidence?: number;
  /** pictures per document; the rest are dropped */
  maxImages: number;
  /** smaller pictures (icons, bullets) are dropped (px) */
  minImagePx: number;
  /** plain-text files longer than this are cut, with a note */
  maxTextChars: number;
  /** turns low-confidence images into text; unset = the image itself goes to the main model */
  visionModel?: LanguageModel;
  visionPrompt: string;
  /** OCR backend: built-in Tesseract (default) or an external server (RapidOCR, PaddleOCR, ...) */
  ocr?: OcrOptions;
  /** LiteParse settings, e.g. `{ ocrLanguage: 'deu' }` or `{ poolSize: 2, parseTimeoutMs: 60_000 }` */
  liteparse?: Partial<LiteParseConfig> & PoolOptions;
  /** called for every OCR'd image; log it to tune `minConfidence` for your engine and documents */
  onOcr?: (confidence: number, toVision: boolean) => void;
}

/**
 * Default `minConfidence` per OCR engine. Engines calibrate confidence differently, so one number can't fit
 * both: on olmOCR-bench (bench/README.md) OCR text starts passing about half the checks at 0.90 for
 * Tesseract and 0.93 for RapidOCR; below 0.85 it passes under a quarter.
 */
export const MIN_CONFIDENCE = { tesseract: 0.9, server: 0.93 } as const;

/** error whose message is safe to show the model */
export class AttachmentError extends Error {}

export class UnsupportedFileTypeError extends AttachmentError {
  constructor(type: string) {
    super(`this file type (${type}) can't be read`);
  }
}

// markdown placeholder LiteParse writes for picture `p1_2`: ![](img_p1_2.jpg)
const IMAGE_REF = /!\[[^\]]*\]\(img_(p\d+_\d+)\.\w+\)/g;
const IMAGE_FORMATS: Readonly<Record<string, string>> = { jpg: FileType.JPEG, jpeg: FileType.JPEG, png: FileType.PNG };

const text = (t: string): Part => ({ type: 'text', text: t });

/** OCR confidence of the whole image: per-item scores weighted by text length; no text at all = 0 */
export function ocrConfidence(items: TextItem[]): number {
  let chars = 0;
  let sum = 0;
  for (const i of items) {
    if (i.confidence === undefined) continue;
    chars += i.text.length;
    sum += i.confidence * i.text.length;
  }
  return chars ? sum / chars : 0;
}

/** a page with no usable native text (scan, handwriting, text drawn as vectors) is read as an image */
const isScanned = (p: ParsedPage) => p.complexity?.reasons.some((r) => r !== 'embedded-images') ?? false;

/** translate the `ocr` option group into LiteParse config; unset fields fall through to LiteParse defaults */
function ocrConfig(ocr: OcrOptions = {}): Partial<LiteParseConfig> {
  const config: Partial<LiteParseConfig> = { numWorkers: Math.min(4, Math.max(1, cpus().length)) };
  if (ocr.language) config.ocrLanguage = ocr.language;
  if (ocr.dpi) config.dpi = ocr.dpi;
  if (ocr.numWorkers) config.numWorkers = ocr.numWorkers;
  if (ocr.tessdataPath) config.tessdataPath = ocr.tessdataPath;
  if (ocr.engine === 'server') {
    // fail at setup, not by silently OCR-ing with Tesseract instead
    if (!ocr.serverUrl) throw new TypeError("ocr: engine 'server' needs `serverUrl`");
    // LiteParse POSTs to the url as given; accept the server's base url too
    const url = ocr.serverUrl.replace(/\/+$/, '');
    config.ocrServerUrl = url.endsWith('/ocr') ? url : `${url}/ocr`;
    if (ocr.serverHeaders) config.ocrServerHeaders = ocr.serverHeaders;
  }
  return config;
}

export function createIngest(opts: IngestOptions) {
  const minConfidence = opts.minConfidence ?? MIN_CONFIDENCE[opts.ocr?.engine === 'server' ? 'server' : 'tesseract'];
  // `ocr` wins over the raw `liteparse` passthrough so the backend is always explicit
  const shared = { ...opts.liteparse, ...ocrConfig(opts.ocr) };
  // documents: native text only; everything raster is OCR'd by processImage, so nothing is read twice
  const documents = new LiteParse({
    ...shared,
    outputFormat: 'markdown',
    ocrEnabled: false,
    extractImages: true,
    includeComplexity: true,
    quiet: true,
  });
  const ocr = new LiteParse({ ...shared, outputFormat: 'markdown', ocrEnabled: true, quiet: true });

  async function ingest(file: InputFile): Promise<Part[]> {
    switch (file.mediaType) {
      case FileType.PDF:
      case FileType.DOCX:
      case FileType.XLSX:
      case FileType.PPTX:
        return ingestDocument(file);

      case FileType.PNG:
      case FileType.JPEG:
      case FileType.WEBP:
      case FileType.TIFF:
        return processImage(file.bytes, file.mediaType);

      case FileType.TXT:
        return ingestText(file);

      default:
        if (isTextType(file.mediaType)) return ingestText(file);
        throw new UnsupportedFileTypeError(file.mediaType);
    }
  }

  async function ingestDocument(file: InputFile): Promise<Part[]> {
    return withInput(file, async (input) => {
      const doc = await documents.parse(input);
      const scanned = doc.pages.filter(isScanned).map((p) => p.pageNum);

      const shots = scanned.length ? await documents.screenshot(input, scanned) : [];
      const pages = new Map(
        await Promise.all(
          shots
            .filter((s) => !s.isSolidFill) // blank page
            .map(async (s) => [s.pageNum, await processImage(s.imageBuffer, FileType.PNG)] as const),
        ),
      );

      // pictures are processed on scanned pages too: page OCR can read a slide's title confidently and
      // still miss its photo (full-page scan rasters are never in doc.images, so nothing is read twice there)
      const pictures = doc.images
        .filter((i) => !i.duplicateOf && Math.min(i.width, i.height) >= opts.minImagePx)
        .slice(0, opts.maxImages);
      const images = new Map(
        await Promise.all(
          pictures.map(
            async (i) => [i.id, await processImage(i.bytes, IMAGE_FORMATS[i.format] ?? `image/${i.format}`)] as const,
          ),
        ),
      );

      return doc.pages.flatMap((p) => {
        const page = pages.get(p.pageNum);
        if (!page) return withImages(p.markdown, images);
        // OCR'd page: its text, then its pictures
        return [...page, ...pictures.filter((i) => i.page === p.pageNum).flatMap((i) => images.get(i.id) ?? [])];
      });
    });
  }

  /** OCR first, always. Low confidence (or no text at all, e.g. a photo) -> vision model. */
  async function processImage(bytes: Buffer, mediaType: string): Promise<Part[]> {
    if (opts.ocr?.engine === 'none') return runVision(bytes, mediaType);
    const result = await ocr.parse(bytes);
    const confidence = ocrConfidence(result.pages.flatMap((p) => p.textItems));
    const toVision = confidence < minConfidence;
    opts.onOcr?.(confidence, toVision);
    if (!toVision) return [text(result.pages.map((p) => p.markdown).join('\n\n'))];
    return runVision(bytes, mediaType);
  }

  async function runVision(bytes: Buffer, mediaType: string): Promise<Part[]> {
    // the model reads PNG/JPEG/WEBP/GIF; anything else (TIFF, JBIG2, ...) is rendered to PNG first
    let [type, data] = [mediaType, bytes];
    if (!MODEL_TYPES.has(type)) [type, data] = [FileType.PNG, (await ocr.screenshot(bytes, [1]))[0].imageBuffer];
    if (!opts.visionModel) return [{ type: 'file', mediaType: type, data: { type: 'data', data } }];
    const { text: description } = await generateText({
      model: opts.visionModel,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: opts.visionPrompt },
            { type: 'file', mediaType: type, data },
          ],
        },
      ],
    });
    return [text(description.trim())];
  }

  function ingestText(file: InputFile): Part[] {
    const all = file.bytes.toString('utf8');
    const cut =
      all.length > opts.maxTextChars ? `\n[cut after ${opts.maxTextChars} characters; the file continues]` : '';
    return [text(all.slice(0, opts.maxTextChars) + cut)];
  }

  return ingest;
}

/** page markdown with each picture placeholder replaced by that picture's parts (dropped pictures vanish) */
function withImages(markdown: string, images: Map<string, Part[]>): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of markdown.matchAll(IMAGE_REF)) {
    parts.push(text(markdown.slice(last, m.index)), ...(images.get(m[1]) ?? []));
    last = m.index + m[0].length;
  }
  parts.push(text(markdown.slice(last)));
  return parts;
}

/** PDFs and images parse from memory; Office files go through a temp file so LibreOffice sees the extension */
async function withInput<T>(file: InputFile, run: (input: Buffer | string) => Promise<T>): Promise<T> {
  const ext = EXTENSIONS[file.mediaType];
  if (!ext) return run(file.bytes);
  const dir = await mkdtemp(join(tmpdir(), 'liteparse-'));
  try {
    const path = join(dir, `file.${ext}`);
    await writeFile(path, file.bytes);
    return await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
