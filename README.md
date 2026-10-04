# @ctxwise/ai-sdk-liteparse

[![npm](https://img.shields.io/npm/v/@ctxwise/ai-sdk-liteparse?color=2a78d6)](https://www.npmjs.com/package/@ctxwise/ai-sdk-liteparse)
[![CI](https://github.com/ctxwise/ai-sdk-liteparse/actions/workflows/ci.yml/badge.svg)](https://github.com/ctxwise/ai-sdk-liteparse/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2a78d6)](https://github.com/ctxwise/ai-sdk-liteparse/blob/main/LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-2a78d6)](https://github.com/ctxwise/ai-sdk-liteparse/blob/main/package.json)
[![AI SDK](https://img.shields.io/badge/AI%20SDK-v7-000000)](https://ai-sdk.dev)

[Vercel AI SDK](https://ai-sdk.dev) middleware that turns chat attachments (PDFs, scans, Word, Excel,
PowerPoint, images) into text the model can read, using [LiteParse](https://github.com/run-llama/liteparse)
in your own Node process. No parsing server. A vision model is used only where OCR is not confident.

```bash
npm i @ctxwise/ai-sdk-liteparse
```

Requirements: Node.js 22 or newer, and the AI SDK v7 (`ai`, `@ai-sdk/provider`) as peer dependencies. It runs
on the server only (Node runtime, not Edge), on Linux, macOS and Windows. PDFs and images need nothing else;
Office files need LibreOffice installed (see [Deploy](#deploy-linux--ecs)).

```ts
import { openai } from '@ai-sdk/openai';
import { liteparseAttachments, noServerDownloads } from '@ctxwise/ai-sdk-liteparse';
import { streamText, wrapLanguageModel } from 'ai';

const model = wrapLanguageModel({
  model: openai('gpt-5-mini'),
  middleware: liteparseAttachments({ visionModel: openai('gpt-5-mini') }),
});

// file parts in user messages are parsed before the model sees them
const result = streamText({
  model,
  messages,
  experimental_download: noServerDownloads, // never fetch URLs found in user messages (SSRF)
});
```

Every file part in a user message is replaced by what the model can read, wrapped in `<document name="...">`.
Parsed files are cached by content hash, so chat history that re-sends a file every turn parses it once.
Runnable examples (Next.js route, plain Node server, structured extraction, parsing without a model) are in
[examples/](https://github.com/ctxwise/ai-sdk-liteparse/tree/main/examples).

## Why

- **In-process.** LiteParse is a native Node module (PDFium + Tesseract). No Python, no Docker sidecar, no
  network hop for the common case.
- **OCR first, vision second.** Scans and pictures are OCR'd; only what OCR can't read confidently goes to a
  vision model, which is where the tokens and latency go.
- **Pluggable OCR.** Built-in Tesseract by default, an external OCR service (e.g. RapidOCR) when you want it,
  or no OCR at all. The package itself stays pure TypeScript with one runtime dependency.
- **Measured.** Engines and thresholds are chosen from a public benchmark with human-verified checks
  ([results](#benchmark)), not from confidence scores alone.

## How files are routed

1. **Documents** (PDF, DOCX, PPTX, XLSX) go to LiteParse. Their text, tables and headings become text directly.
2. **Pictures inside documents** and **pages without usable text** (scans, handwriting) become images.
3. **Uploaded images** (PNG, JPEG, WEBP, TIFF) are images from the start.
4. Every image, whatever its source, goes through one function, `processImage()`: OCR first; if the OCR
   confidence is at least `minConfidence` the OCR text is kept, otherwise the image goes to the vision model.

- **Native text first.** Text, tables and headings come straight from the file: no OCR, exact. A page is
  read as an image only when its text layer is missing or unusable (a scan, garbled fonts, text drawn as
  vector outlines), never just because it has little text. Spreadsheets keep one row per line.
- **Vision model.** With `visionModel`, a low-confidence image is turned into text by that model, so the main
  model gets text only. Without it, the image itself goes to the main model.
- **Text files** (`text/*`, JSON, XML, YAML, ...) are read as-is. **Other types** get a short note; PDFs and
  images the model reads natively pass through untouched if parsing fails.

## OCR engines

Pick the engine with the `ocr` option:

```ts
liteparseAttachments({ ocr: { engine: 'tesseract' } });                               // default
liteparseAttachments({ ocr: { engine: 'server', serverUrl: 'http://rapidocr:8829' } }); // OCR service
liteparseAttachments({ ocr: { engine: 'none' } });                                    // no OCR
```

| engine | runs | best for |
|---|---|---|
| `tesseract` (default) | inside LiteParse, in your process | most apps; zero setup |
| `server` | any HTTP service speaking LiteParse's [`POST /ocr` contract](https://github.com/run-llama/liteparse/blob/main/OCR_API_SPEC.md) | offloading OCR to its own scalable service; other engines |
| `none` | nowhere | native text + every image to the vision model; fastest parse, most vision tokens |

**RapidOCR service.** [ocr/rapidocr](https://github.com/ctxwise/ai-sdk-liteparse/tree/main/ocr/rapidocr) is a ready server: PP-OCRv5 on ONNX Runtime, CPU only,
models baked into the image at build time. It is not part of the npm package and runs only when you start it:

```bash
docker compose --profile rapidocr up -d
```

At scale, run it as its own service (e.g. an ECS service behind an internal load balancer) and scale it
independently of the app. `OCR_THREADS` (default 4) sets ONNX threads per request; each container handles
`CPUs / OCR_THREADS` requests at once and queues the rest.

## Choosing `minConfidence`

OCR engines report a confidence per line. It is the engine's own estimate, **not a measure of correctness**,
and engines scale it differently: RapidOCR's scores sit higher than Tesseract's on the same pages.

![Page confidence vs checks passed](https://raw.githubusercontent.com/ctxwise/ai-sdk-liteparse/main/docs/images/confidence.png)

The threshold was chosen by replaying routing on the [benchmark](#benchmark) at every value from 0.50 to 1.00:
a page whose OCR confidence is at or above the threshold keeps its OCR text, anything below goes to the vision
model. The rule: the cheapest threshold whose score is within 1 point of the best.

![Quality vs share of pages sent to the vision model](https://raw.githubusercontent.com/ctxwise/ai-sdk-liteparse/main/docs/images/threshold.png)

There is no knee: quality rises all the way until every page that needed OCR goes to the vision model. So the
defaults (`MIN_CONFIDENCE`) are **0.94 for Tesseract and 0.96 for an OCR server** (tuned on RapidOCR):
only near-perfect OCR skips the vision model. What that means in practice:

- **With `visionModel`:** scans and pictures are read by the vision model; OCR saves the call only on very
  clean pages. gpt-5-mini cost about $0.005 per page image in the benchmark.
- **Without `visionModel`:** low-confidence images go to the main model as images; OCR is what turns the rest
  into cheap text.
- **Cheaper, lower quality:** set a lower `minConfidence` (e.g. 0.85) to keep more OCR text and send fewer
  images.

For your own documents, log what the pipeline sees and set `minConfidence` explicitly:

```ts
liteparseAttachments({ minConfidence: 0.9, onOcr: (confidence, toVision) => metrics.record({ confidence, toVision }) });
```

## Benchmark

[olmOCR-bench](https://huggingface.co/datasets/allenai/olmOCR-bench) `old_scans` + `long_tiny_text`: the first
30 pages of each, sorted by name (60 pages, 363 human-verified checks). Every page went through this package's
real pipeline in the Linux image and was scored with olmOCR's official scorer (`olmocr[bench]==0.4.27`).
The OCR rows keep OCR text on every page to measure the engines alone.

| mode | score (± 95% CI) | old scans | long tiny text | median / p95 per page |
|---|---|---|---|---|
| Tesseract | 35.9% ± 4.8 | 20.1% | 51.8% | 2.6 s / 12.0 s |
| RapidOCR (PP-OCRv5) | 38.3% ± 4.7 | 24.4% | 52.3% | 6.2 s / 14.9 s |
| Vision model only (`engine: 'none'`, gpt-5-mini) | **51.6% ± 5.3** | **49.4%** | 53.8% | 15.5 s / 86.5 s |
| Tesseract, vision below 0.94 (default) | 51.6% | | | |

![Accuracy by mode](https://raw.githubusercontent.com/ctxwise/ai-sdk-liteparse/main/docs/images/quality.png)
![Speed per page](https://raw.githubusercontent.com/ctxwise/ai-sdk-liteparse/main/docs/images/speed.png)

Takeaways:

- **The vision model more than doubles accuracy on old scans** (49% vs 20 to 24%). This is where it earns its
  tokens: the whole 60-page run cost about $0.16 (124K input + 63K output tokens).
- **RapidOCR is not measurably more accurate than Tesseract** (inside the confidence interval) and is about 2x
  slower per page. Keep Tesseract as the default; use the RapidOCR service to move OCR off the app's CPUs.
- **Pages with a real text layer need neither**: 27 of the 30 "long tiny text" pages parsed natively in ~0.1 s.

Timings: app container capped at 2 vCPU / 4 GB (a small ECS task); RapidOCR in its own 2-vCPU container over
HTTP; pages one at a time; vision times include the API round trip. 60 pages: differences under the ±5-point
interval are not real differences, and only English-heavy sets were measured.

## Deploy (Linux / ECS)

PDFs and images need nothing but the npm package. Office files need LibreOffice. Add to your app image
(see [Dockerfile](https://github.com/ctxwise/ai-sdk-liteparse/blob/main/Dockerfile)):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core \
      libreoffice-writer libreoffice-calc libreoffice-impress && rm -rf /var/lib/apt/lists/*
# Tesseract's language data; without it LiteParse downloads it on the first OCR
ADD --checksum=sha256:8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba \
    https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata /usr/share/tessdata/eng.traineddata
ENV TESSDATA_PREFIX=/usr/share/tessdata
```

On small tasks (2 vCPU / 4 GB):

- Peak memory in the benchmark was 770 MB (Tesseract) to 880 MB (with RapidOCR) per process on dense scans.
- For a hard per-document deadline and crash isolation, use a worker pool:
  `liteparse: { poolSize: 1, parseTimeoutMs: 60_000 }` (each worker is a separate process).
- OCR workers already cap at `min(4, CPUs)`; keep `liteparse.dpi` at 150 unless scans need 200.
- Lower `cacheMB` and `maxFileBytes` if the task runs other work.

## Options

| option | default | |
|---|---|---|
| `ocr` | `{ engine: 'tesseract' }` | `engine` (`tesseract` / `server` / `none`), `serverUrl`, `serverHeaders` |
| `minConfidence` | per engine (`MIN_CONFIDENCE`) | OCR below this (0-1) goes to the vision model; an image with no text scores 0 |
| `visionModel` | unset | e.g. `openai('gpt-5-mini')`; unset = images go to the main model |
| `visionPrompt` | see `DEFAULTS` | instruction for `visionModel` |
| `onOcr` | unset | `(confidence, toVision) => void` for every OCR'd image |
| `maxImages` | `20` | pictures per document |
| `minImagePx` | `48` | smaller pictures (icons, bullets) are dropped |
| `maxTextChars` | `200000` | plain-text files are cut after this, with a note |
| `maxFileBytes` | `50 MB` | larger files are not parsed |
| `cacheMB` | `256` | in-memory cache of parsed files, by sha256 |
| `liteparse` | unset | LiteParse config, e.g. `{ ocrLanguage: 'deu', dpi: 200 }` or `{ poolSize: 1, parseTimeoutMs: 60000 }` |
| `onError` | `console.warn` | errors that were turned into a note or a passthrough |

Also exported: `FileType`, `mediaTypeOf` (media type from a file name, for files read on the server),
`noServerDownloads`, `createIngest` (the parsing pipeline without a model), `MIN_CONFIDENCE`, `DEFAULTS`.

## Develop

```bash
npm test                                               # LiteParse for real on the fixtures (Office skipped without LibreOffice)
docker build -t ai-sdk-liteparse . && docker run --rm ai-sdk-liteparse   # all tests on Linux, as in production
```

Examples: [examples/](https://github.com/ctxwise/ai-sdk-liteparse/tree/main/examples).

## Related

- [`@ctxwise/ai-sdk-docling`](https://github.com/ctxwise/ai-sdk-docling): the same middleware backed by a
  [docling-serve](https://github.com/ctxwise/docling-serve) server instead of an in-process parser. It adds layout
  models, picture classification and table structure, at the cost of running a service.

## License

MIT
