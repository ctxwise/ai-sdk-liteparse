/**
 * Typed JSON out of a document: LiteParse reads the tables and scans; the model fills a schema.
 *
 * Run: dotenvx run -- node examples/05-structured-extraction.ts test/fixtures/sales.xlsx   (xlsx needs LibreOffice)
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openai } from '@ai-sdk/openai';
import { liteparseAttachments, mediaTypeOf, noServerDownloads } from '@ctxwise/ai-sdk-liteparse';
import { generateText, jsonSchema, Output, wrapLanguageModel } from 'ai';

const path = process.argv[2] ?? 'test/fixtures/sales.xlsx';

// 1. The shape to extract.
interface Report {
  title: string;
  currency: string | null;
  figures: { label: string; period: string; value: number }[];
}

const schema = jsonSchema<Report>({
  type: 'object',
  additionalProperties: false,
  required: ['title', 'currency', 'figures'],
  properties: {
    title: { type: 'string' },
    currency: { type: ['string', 'null'] },
    figures: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label', 'period', 'value'],
        properties: { label: { type: 'string' }, period: { type: 'string' }, value: { type: 'number' } },
      },
    },
  },
});

// 2. The wrapped model, as in every other example.
const model = wrapLanguageModel({ model: openai('gpt-5-mini'), middleware: liteparseAttachments() });

// 3. Ask for structured output against the attached file.
const { output } = await generateText({
  model,
  experimental_download: noServerDownloads,
  output: Output.object({ schema }),
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Extract every reported figure from this document.' },
        { type: 'file', data: await readFile(path), filename: basename(path), mediaType: mediaTypeOf(path) },
      ],
    },
  ],
});

console.table(output.figures);
