import { createHash } from 'node:crypto';
import type { LanguageModelV4FilePart, LanguageModelV4Middleware } from '@ai-sdk/provider';
import { PromiseCache } from './cache.ts';
import { MODEL_TYPES } from './constants.ts';
import { AttachmentError, createIngest, type IngestOptions, type Part } from './ingest.ts';

export interface LiteparseAttachmentsOptions extends Partial<IngestOptions> {
  /** larger files are not parsed (the model gets a note, or the original for PDFs/images). @default 52428800 (50 MB) */
  maxFileBytes?: number;
  /** memory for parsed files; chat history re-sends the same files every turn. @default 256 */
  cacheMB?: number;
  /** called with errors that were turned into a note or a passthrough. @default console.warn */
  onError?: (error: unknown, filename: string) => void;
}

export const DEFAULTS = {
  maxImages: 20,
  minImagePx: 48,
  maxTextChars: 200_000,
  maxFileBytes: 50 * 2 ** 20,
  cacheMB: 256,
  visionPrompt:
    'Convert this image to text for another AI that cannot see it. Transcribe all text exactly, including handwriting; ' +
    'tables as Markdown with exact numbers. For charts: the chart type, axis labels and every data value. ' +
    'For photos and illustrations: a concise factual description. Output only the content, no preamble.',
} as const satisfies LiteparseAttachmentsOptions;

const sha256 = (...data: (string | Uint8Array)[]) =>
  data.reduce((h, d) => h.update(d), createHash('sha256')).digest('hex');
const safeName = (name = 'attachment') => name.replace(/[^\p{L}\p{N} ._()-]/gu, '_').slice(-100);

/** inline bytes, or null for a remote URL / provider reference (the provider reads those itself) */
function bytesOf(part: LanguageModelV4FilePart): Buffer | null {
  const d = part.data;
  if (d.type === 'data') return typeof d.data === 'string' ? Buffer.from(d.data, 'base64') : Buffer.from(d.data);
  if (d.type === 'text') return Buffer.from(d.text, 'utf8');
  if (d.type === 'url' && d.url.protocol === 'data:') return Buffer.from(d.url.href.split(',')[1], 'base64');
  return null;
}

/** merges adjacent text parts and drops empty ones; copies them so cached parts are never mutated */
function mergeText(parts: Part[]): Part[] {
  return parts.reduce<Part[]>((acc, p) => {
    const last = acc.at(-1);
    if (p.type === 'text' && !p.text.trim()) return acc;
    if (p.type === 'text' && last?.type === 'text') last.text += `\n${p.text}`;
    else acc.push(p.type === 'text' ? { ...p } : p);
    return acc;
  }, []);
}

/** AI SDK middleware: every attachment in a user message becomes text (plus images OCR could not read). */
export function liteparseAttachments(options: LiteparseAttachmentsOptions = {}): LanguageModelV4Middleware {
  // explicit `undefined` (e.g. an unset env var) keeps the default
  const set = Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
  const opts = { ...DEFAULTS, ...set } as typeof DEFAULTS & LiteparseAttachmentsOptions;
  const onError = opts.onError ?? ((e, name) => console.warn(`[ai-sdk-liteparse] ${name}:`, e));
  const ingest = createIngest(opts);

  // ponytail: in-process cache; move to Redis/blob keyed by the same sha256 when running >1 instance
  const cache = new PromiseCache<Part[]>(opts.cacheMB * 2 ** 20, (parts) =>
    parts.reduce((n, p) => {
      const d = p.type === 'text' ? p.text : p.data.type === 'data' ? p.data.data : '';
      return n + (typeof d === 'string' ? d.length : d.byteLength);
    }, 0),
  );

  async function route(p: Part): Promise<Part[]> {
    if (p.type !== 'file') return [p];
    const name = safeName(p.filename);
    try {
      const bytes = bytesOf(p);
      if (!bytes) return [p];
      if (bytes.length > opts.maxFileBytes) throw new AttachmentError('the file is too large to read');
      // keyed on the file itself so the same upload is parsed once across turns and users
      const parts = await cache.get(sha256(bytes, p.mediaType), () => ingest({ bytes, mediaType: p.mediaType }));
      return mergeText([text(`<document name="${name}">`), ...parts, text('</document>')]);
    } catch (e) {
      // details go to onError; the model only gets a safe, generic reason
      if (!(e instanceof AttachmentError)) onError(e, name);
      if (MODEL_TYPES.has(p.mediaType)) return [p]; // the model can still read the original
      const reason = e instanceof AttachmentError ? e.message : 'the file could not be read';
      return [text(`[attachment "${name}": ${reason}]`)];
    }
  }

  return {
    specificationVersion: 'v4',
    transformParams: async ({ params }) => ({
      ...params,
      prompt: await Promise.all(
        params.prompt.map(async (msg) =>
          msg.role === 'user' ? { ...msg, content: (await Promise.all(msg.content.map(route))).flat() } : msg,
        ),
      ),
    }),
  };
}

const text = (t: string): Part => ({ type: 'text', text: t });
