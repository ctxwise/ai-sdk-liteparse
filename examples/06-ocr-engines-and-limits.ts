/**
 * Tuning the middleware: OCR engine, vision threshold, limits and logging.
 * Every option not set here keeps its default (see `DEFAULTS` and `MIN_CONFIDENCE`).
 */
import { openai } from '@ai-sdk/openai';
import { liteparseAttachments, MIN_CONFIDENCE } from '@ctxwise/ai-sdk-liteparse';
import { wrapLanguageModel } from 'ai';

export const model = wrapLanguageModel({
  model: openai('gpt-5-mini'),
  middleware: liteparseAttachments({
    // 1. OCR engine. Default: Tesseract in this process. Here: the RapidOCR service
    //    (docker compose --profile rapidocr up -d), so OCR runs on its own, separately scaled CPUs.
    //    { engine: 'none' } skips OCR: native text only, every image to the vision model.
    ocr: { engine: 'server', serverUrl: process.env.OCR_URL ?? 'http://127.0.0.1:8829', language: 'en' },

    // 2. Vision threshold: images whose OCR confidence is below this go to the vision model.
    //    The default is per engine, because engines scale confidence differently; tune it on your documents.
    minConfidence: MIN_CONFIDENCE.server,
    visionModel: openai('gpt-5-mini'),
    onOcr: (confidence, toVision) => console.log({ event: 'ocr', confidence, toVision }),

    // 3. Limits: smaller files, fewer pictures, and a hard deadline per document. With `poolSize`, each parse
    //    runs in a separate worker process that is killed when it passes `parseTimeoutMs`.
    maxFileBytes: 20 * 2 ** 20, // 20 MB
    maxImages: 5,
    liteparse: { poolSize: 1, parseTimeoutMs: 2 * 60_000, maxPages: 50 },

    // 4. Parse failures: the model gets a short note, your logs get the details.
    onError: (error, filename) => console.error({ event: 'attachment_failed', filename, error: String(error) }),
  }),
});
