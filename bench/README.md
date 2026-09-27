# Benchmark

How the OCR engines and the `minConfidence` threshold in the main README were measured. Dev-only: nothing here
ships in the npm package.

## Method

- **Data:** [olmOCR-bench](https://huggingface.co/datasets/allenai/olmOCR-bench), public, with human-verified
  checks per page ("this sentence is present", "this header is absent", "A comes before B"). Two sets where
  the OCR engine matters: `old_scans` and `long_tiny_text`. Sample: the first 30 pages of each, sorted by
  name (60 pages, 363 checks) — fixed and reproducible, not hand-picked.
- **Pipeline:** every page goes through the package's real `ingest()` — the same code the middleware runs.
  [olmocr.ts](olmocr.ts) writes the text the model would get.
- **Scoring:** olmOCR's own scorer, unmodified (`olmocr[bench]==0.4.27`, [score.Dockerfile](score.Dockerfile)).
  [analyze.py](analyze.py) uses the same test classes per page; its totals match the official scorer exactly.
- **Configs:** Tesseract (built in), RapidOCR ([ocr/rapidocr](../ocr/rapidocr), PP-OCRv5 on ONNX Runtime) and
  `engine: 'none'` with `openai/gpt-5-mini` via OpenRouter reading every page image.
- **Threshold:** the OCR runs keep OCR text on every page (`minConfidence: 0`) but record each page's
  confidence. Routing at any threshold is then replayed offline: page confidence ≥ t → OCR text, else the
  vision model's text for that page. No extra model calls per threshold.
- **Choosing t:** the cheapest threshold (fewest pages to the vision model) whose score is within 1 point of
  the best routed score. Beyond it, more vision spend buys no measurable quality.

## Run

```bash
# data (≈ 90 MB) into bench/data
uvx --from huggingface_hub hf download allenai/olmOCR-bench --repo-type dataset --local-dir bench/data/olmOCR-bench \
  --include "bench_data/old_scans.jsonl" "bench_data/long_tiny_text.jsonl" \
            "bench_data/pdfs/old_scans/*" "bench_data/pdfs/long_tiny_text/*"

# images: the app image (LibreOffice + Tesseract data), the RapidOCR service, the scorer
docker build -t ai-sdk-liteparse .
docker build -t ai-sdk-liteparse-rapidocr ocr/rapidocr
docker build -f bench/score.Dockerfile -t olmocr-score bench
docker network create lpbench
docker run -d --name rapidocr --network lpbench ai-sdk-liteparse-rapidocr

# outputs (Linux, like production)
V="-v $PWD/bench/data:/app/bench/data -v $PWD/bench/results:/app/bench/results"
docker run --rm --network lpbench $V ai-sdk-liteparse node bench/olmocr.ts --name tesseract --limit 30
docker run --rm --network lpbench $V ai-sdk-liteparse node bench/olmocr.ts --name rapidocr --ocr-url http://rapidocr:8829 --limit 30
dotenvx run -- node bench/olmocr.ts --name vision --vision openai/gpt-5-mini --limit 30   # OPENROUTER_API_KEY

# score + charts (docs/images) + bench/results/report.json
docker run --rm -v $PWD/bench/data/sample:/data olmocr-score --skip_baseline
docker run --rm --entrypoint python -v $PWD/bench:/bench -v $PWD/docs:/docs olmocr-score /bench/analyze.py
```

`bench/results/*.json` (committed) hold every page's timing, confidence and token count, so the analysis and
charts can be redone without re-running OCR or the model.

## Caveats

- 60 pages: differences under the ±5-point confidence interval are not real differences.
- Timings are from one shared dev machine (16 vCPU Docker VM) that was also running another heavy job; use them
  to compare engines, not as capacity numbers. RapidOCR ran in its own container, over HTTP.
- Only English-heavy sets. Other scripts need their own run (`ocr.language`, a RapidOCR model per language).
