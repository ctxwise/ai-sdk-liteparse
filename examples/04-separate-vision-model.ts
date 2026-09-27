/**
 * A separate vision model: gpt-5-mini reads the images OCR could not read confidently, and the main model
 * receives text only. Useful when the main model is expensive or can't read images.
 *
 * Run: dotenvx run -- node examples/04-separate-vision-model.ts test/fixtures/mixed.pdf
 */
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openai } from '@ai-sdk/openai';
import { liteparseAttachments, mediaTypeOf, noServerDownloads } from '@ctxwise/ai-sdk-liteparse';
import { streamText, wrapLanguageModel } from 'ai';

const path = process.argv[2] ?? 'test/fixtures/mixed.pdf';

// 1. Two models: the main one answers; the vision one turns low-confidence images into text first.
//    Parsed files, vision text included, are cached by content hash, so chat history doesn't pay again.
const model = wrapLanguageModel({
  model: openai('gpt-5'),
  middleware: liteparseAttachments({
    visionModel: openai('gpt-5-mini'),
    visionPrompt: 'Transcribe all text exactly and tables as Markdown. For charts, list every value.',
  }),
});

// 2. Ask about the document as usual.
const result = streamText({
  model,
  experimental_download: noServerDownloads,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'What does the handwritten page say, and how does it relate to the printed page?' },
        { type: 'file', data: await readFile(path), filename: basename(path), mediaType: mediaTypeOf(path) },
      ],
    },
  ],
});

// 3. Print the answer as it streams.
for await (const delta of result.textStream) process.stdout.write(delta);
