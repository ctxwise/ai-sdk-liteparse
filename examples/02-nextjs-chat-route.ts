/**
 * Next.js App Router chat route (app/api/chat/route.ts) for a standard `useChat` page.
 * The browser sends attachments as data URLs; they are parsed here, before the model sees them.
 */
import { openai } from '@ai-sdk/openai';
import { liteparseAttachments, noServerDownloads } from '@ctxwise/ai-sdk-liteparse';
import { convertToModelMessages, streamText, type UIMessage, wrapLanguageModel } from 'ai';

// Next.js route config: parsing runs inside this function, so it needs the Node runtime (not Edge),
// and OCR of a scan takes seconds per page on CPU, so allow up to 5 minutes.
export const runtime = 'nodejs';
export const maxDuration = 300;

// 1. Wrap the model at module scope, so every request shares one middleware and its parse cache.
const model = wrapLanguageModel({ model: openai('gpt-5-mini'), middleware: liteparseAttachments() });

export async function POST(req: Request) {
  // 2. Turn the UI messages from useChat into model messages (file parts included).
  const { messages }: { messages: UIMessage[] } = await req.json();

  // 3. Stream the answer back in the format useChat expects.
  return streamText({
    model,
    system: 'Answer from the attached documents. Say so when something is not in them.',
    messages: await convertToModelMessages(messages),
    experimental_download: noServerDownloads, // never fetch URLs found in messages (SSRF)
  }).toUIMessageStreamResponse();
}
