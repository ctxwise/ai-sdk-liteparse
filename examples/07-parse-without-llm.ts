/**
 * No LLM: the same pipeline on its own, e.g. to index documents for search.
 * Prints the text a model would receive, with images OCR could not read as [image] markers.
 *
 * Run: node examples/07-parse-without-llm.ts test/fixtures/scan.pdf
 */
import { readFile } from 'node:fs/promises';
import { createIngest, DEFAULTS, mediaTypeOf } from '@ctxwise/ai-sdk-liteparse';

const path = process.argv[2] ?? 'test/fixtures/scan.pdf';

// 1. Build the parser. minConfidence 0 keeps OCR text for every image, which is what search indexing wants;
//    onOcr shows how confident OCR was about each one.
const ingest = createIngest({
  ...DEFAULTS,
  minConfidence: 0,
  onOcr: (confidence) => console.log(`[ocr confidence ${confidence.toFixed(2)}]`),
});

// 2. Parse: text parts in reading order, and file parts for images that would go to a vision model.
const parts = await ingest({ bytes: await readFile(path), mediaType: mediaTypeOf(path) });

// 3. Print them.
for (const part of parts) console.log(part.type === 'text' ? part.text : `[image ${part.mediaType}]`);
