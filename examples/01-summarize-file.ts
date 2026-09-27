/**
 * Summarize any document in one call: PDF, scan, Word, PowerPoint, Excel or image.
 *
 * Run: dotenvx run -- node examples/01-summarize-file.ts test/fixtures/scan.pdf
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openai } from '@ai-sdk/openai';
import { liteparseAttachments, mediaTypeOf, noServerDownloads } from '@ctxwise/ai-sdk-liteparse';
import { generateText, wrapLanguageModel } from 'ai';

const path = process.argv[2] ?? 'test/fixtures/scan.pdf';

// 1. Wrap the model once. Attachments are parsed in this process before the model sees them.
const model = wrapLanguageModel({ model: openai('gpt-5-mini'), middleware: liteparseAttachments() });

// 2. Attach the file as a normal AI SDK file part. On the server nothing supplies a media type, so derive it.
const { text, usage } = await generateText({
  model,
  experimental_download: noServerDownloads, // never fetch URLs found in messages
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Summarize this document in five bullet points, with the key numbers.' },
        { type: 'file', data: await readFile(path), filename: basename(path), mediaType: mediaTypeOf(path) },
      ],
    },
  ],
});

// 3. The answer, and what it cost.
console.log(text);
console.log(`\n${usage.inputTokens} input tokens`);
