# Examples

| Example | Shows |
|---|---|
| [01-summarize-file.ts](01-summarize-file.ts) | any document -> `generateText`, server-side, no UI |
| [02-nextjs-chat-route.ts](02-nextjs-chat-route.ts) | Next.js App Router route for `useChat` |
| [03-node-http-server.ts](03-node-http-server.ts) | the same chat endpoint on plain Node |
| [04-separate-vision-model.ts](04-separate-vision-model.ts) | `visionModel`: a second model reads what OCR couldn't, the main model gets text |
| [05-structured-extraction.ts](05-structured-extraction.ts) | typed JSON out of a spreadsheet, scan or PDF with `Output.object` |
| [06-ocr-engines-and-limits.ts](06-ocr-engines-and-limits.ts) | OCR engine (RapidOCR service), vision threshold, limits, deadlines, logging |
| [07-parse-without-llm.ts](07-parse-without-llm.ts) | the parsing pipeline alone, no model |

## Running

From the repository root, with `OPENAI_API_KEY` in `.env`:

```bash
npm install
npm run build        # the examples import the package by name, which resolves to dist/
dotenvx run -- node examples/01-summarize-file.ts test/fixtures/scan.pdf
```

- PDFs and images work anywhere. Office files (docx, xlsx, pptx) need LibreOffice, so run those in the
  repository's Docker image.
- Example 06 expects the RapidOCR service: `docker compose --profile rapidocr up -d`.
- The examples are type-checked with the rest of the repository (`npm run typecheck`), so they stay in sync with
  the API.
