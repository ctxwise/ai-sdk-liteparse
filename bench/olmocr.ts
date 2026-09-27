/**
 * Runs olmOCR-bench pages through the real ingest() and writes the text the model would get, in the layout the
 * official scorer reads: <out>/<name>/<set>/<pdf>_pg1_repeat1.md, next to <out>/<set>.jsonl (the tests of the
 * converted pages only) and <out>/pdfs. Scoring is olmOCR's own code (see bench/README.md).
 *
 *   node bench/olmocr.ts --name tesseract --limit 30
 *   node bench/olmocr.ts --name rapidocr --ocr-url http://rapidocr:8829 --limit 30
 *   dotenvx run -- node bench/olmocr.ts --name vision --vision openai/gpt-5-mini --limit 30   # no OCR, via OpenRouter
 */
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { createOpenAI } from '@ai-sdk/openai';
import { wrapLanguageModel } from 'ai';
import { FileType } from '../src/constants.ts';
import { createIngest } from '../src/ingest.ts';
import { DEFAULTS } from '../src/middleware.ts';

const { values: args } = parseArgs({
  options: {
    name: { type: 'string', default: 'tesseract' },
    'ocr-url': { type: 'string' },
    // 0 = always keep OCR text, so the score measures the OCR engine alone; confidence is still recorded
    'min-confidence': { type: 'string', default: '0' },
    data: { type: 'string', default: 'bench/data/olmOCR-bench/bench_data' },
    out: { type: 'string', default: 'bench/data/sample' },
    sets: { type: 'string', default: 'old_scans,long_tiny_text' },
    // first N pages of each set, sorted by name (a fixed, reproducible sample)
    limit: { type: 'string' },
    // OpenRouter model id: OCR off (engine 'none'), every image read by this vision model
    vision: { type: 'string' },
  },
});

let usage = { input: 0, output: 0 };
const visionModel = args.vision
  ? wrapLanguageModel({
      model: createOpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_API_KEY }).chat(
        args.vision,
      ),
      middleware: {
        specificationVersion: 'v4',
        // OpenRouter reserves credit for the maximum output on every call; a page needs far less
        transformParams: async ({ params }) => ({ ...params, maxOutputTokens: 8000 }),
        wrapGenerate: async ({ doGenerate }) => {
          const r = await doGenerate();
          usage.input += r.usage.inputTokens.total ?? 0;
          usage.output += r.usage.outputTokens.total ?? 0;
          return r;
        },
      },
    })
  : undefined;

let confidences: number[] = [];
const url = args['ocr-url'];
const ingest = createIngest({
  ...DEFAULTS,
  minConfidence: Number(args['min-confidence']),
  ocr: visionModel ? { engine: 'none' } : url ? { engine: 'server', serverUrl: url } : { engine: 'tesseract' },
  visionModel,
  onOcr: (c) => confidences.push(c),
});

interface Row {
  set: string;
  pdf: string;
  ms: number;
  chars: number;
  /** OCR confidence of each image read on the page (the page render, pictures) */
  confidences: number[];
  /** vision model tokens for this page */
  tokens: { input: number; output: number };
  error?: string;
}
// finished pages are appended here, so an interrupted run resumes without redoing (or re-paying for) them
mkdirSync('bench/results', { recursive: true });
const progress = `bench/results/${args.name}.progress.jsonl`;
const done = new Map<string, Row>(
  (existsSync(progress) ? readFileSync(progress, 'utf8').split('
').filter(Boolean) : [])
    .map((line) => JSON.parse(line) as Row)
    .filter((r) => !r.error)
    .map((r) => [`${r.set}/${r.pdf}`, r]),
);
const rows: Row[] = [];
for (const set of args.sets.split(',')) {
  const pdfs = readdirSync(join(args.data, 'pdfs', set))
    .filter((f) => f.endsWith('.pdf'))
    .sort()
    .slice(0, args.limit ? Number(args.limit) : undefined);

  // the sample as its own bench_data folder: these pdfs and only their tests
  mkdirSync(join(args.out, 'pdfs', set), { recursive: true });
  mkdirSync(join(args.out, args.name, set), { recursive: true });
  for (const pdf of pdfs) copyFileSync(join(args.data, 'pdfs', set, pdf), join(args.out, 'pdfs', set, pdf));
  const wanted = new Set(pdfs.map((p) => `${set}/${p}`));
  const tests = readFileSync(join(args.data, `${set}.jsonl`), 'utf8')
    .split('\n')
    .filter((line) => line.trim() && wanted.has(JSON.parse(line).pdf));
  writeFileSync(join(args.out, `${set}.jsonl`), `${tests.join('\n')}\n`);

  for (const pdf of pdfs) {
    const finished = done.get(`${set}/${pdf}`);
    if (finished) {
      rows.push(finished);
      continue;
    }
    confidences = [];
    usage = { input: 0, output: 0 };
    const t0 = performance.now();
    let text = '';
    let error: string | undefined;
    try {
      const parts = await ingest({ bytes: readFileSync(join(args.data, 'pdfs', set, pdf)), mediaType: FileType.PDF });
      text = parts.map((p) => (p.type === 'text' ? p.text : '')).join('\n');
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    const ms = performance.now() - t0;
    writeFileSync(join(args.out, args.name, set, `${basename(pdf, '.pdf')}_pg1_repeat1.md`), text);
    const row = { set, pdf, ms, chars: text.length, confidences, tokens: usage, error };
    rows.push(row);
    appendFileSync(progress, `${JSON.stringify(row)}
`);
    const conf = confidences.map((c) => c.toFixed(2)).join(',');
    console.log(`${set}/${pdf} ${ms.toFixed(0)} ms ${text.length} chars conf=${conf}${error ? ` ERROR ${error}` : ''}`);
  }
}

const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
const summary = {
  name: args.name,
  pages: rows.length,
  errors: rows.filter((r) => r.error).length,
  inputTokens: rows.reduce((n, r) => n + r.tokens.input, 0),
  outputTokens: rows.reduce((n, r) => n + r.tokens.output, 0),
  p50ms: Math.round(ms[Math.floor(ms.length * 0.5)]),
  p95ms: Math.round(ms[Math.min(ms.length - 1, Math.floor(ms.length * 0.95))]),
  peakRssMB: Math.round(process.resourceUsage().maxRSS / 1024),
};
writeFileSync(`bench/results/${args.name}.json`, JSON.stringify({ summary, rows }, null, 2));
rmSync(progress);
console.log(summary);
