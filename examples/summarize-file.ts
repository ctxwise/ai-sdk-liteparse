/**
 * Summarize any document in one call: PDF, scan, Word, PowerPoint, Excel or image.
 *
 * Run: dotenvx run -- node examples/summarize-file.ts test/fixtures/scan.pdf
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openai } from '@ai-sdk/openai';
import { FileType, liteparseAttachments } from '@ctxwise/ai-sdk-liteparse';
import { generateText, wrapLanguageModel } from 'ai';

const path = process.argv[2] ?? 'test/fixtures/scan.pdf';

// 1. Wrap the model once. Attachments are parsed in-process before the model sees them.
//    Optional: `visionModel: openai('gpt-5-mini')` turns low-confidence images into text too.
const model = wrapLanguageModel({ model: openai('gpt-5-mini'), middleware: liteparseAttachments() });

// 2. Attach the file as a normal AI SDK file part.
const { text, usage } = await generateText({
  model,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Summarize this document in five bullet points, with the key numbers.' },
        { type: 'file', data: await readFile(path), filename: basename(path), mediaType: FileType.PDF },
      ],
    },
  ],
});

// 3. The answer, and what it cost.
console.log(text);
console.log(`\n${usage.inputTokens} input tokens`);
