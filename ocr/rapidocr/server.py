"""RapidOCR (PP-OCR models on ONNX Runtime, CPU) behind LiteParse's OCR API: POST /ocr -> {results: [...]}.

Spec: https://github.com/run-llama/liteparse/blob/main/OCR_API_SPEC.md
"""

import os
import threading

import numpy as np
import uvicorn
from fastapi import FastAPI, Form, HTTPException, UploadFile
from PIL import Image
from rapidocr import OCRVersion, RapidOCR

# ONNX Runtime threads per request. Its default (every core) oversubscribes the CPU: a dense page took 110 s
# with it and 59 s with 4 threads on the same box.
THREADS = int(os.environ.get("OCR_THREADS", "4"))
# requests OCR'd at once; more wait in line instead of fighting over the same cores
slots = threading.Semaphore(max(1, (os.cpu_count() or 1) // THREADS))

# ponytail: one model set (PP-OCRv5, Chinese+English, reads Latin text too); `language` is accepted but not used.
# Load per-language engines here when non-Latin scripts are needed.
engine = RapidOCR(
    params={
        "Det.ocr_version": OCRVersion.PPOCRV5,
        "Rec.ocr_version": OCRVersion.PPOCRV5,
        # LiteParse handles rotated text from the polygons; the angle classifier only costs time
        "Global.use_cls": False,
        "EngineConfig.onnxruntime.intra_op_num_threads": THREADS,
    }
)
app = FastAPI()


@app.get("/health")
def health() -> dict:
    return {"status": "ok"}


@app.post("/ocr")
def ocr(file: UploadFile, language: str = Form("en")) -> dict:
    # sync def: FastAPI runs it in its thread pool, so requests OCR concurrently
    try:
        image = np.array(Image.open(file.file).convert("RGB"))
    except Exception as e:
        raise HTTPException(400, f"not an image: {e}") from e
    with slots:
        out = engine(image)
    if out.boxes is None:
        return {"results": []}
    results = []
    for box, text, score in zip(out.boxes.tolist(), out.txts, out.scores):
        xs, ys = [p[0] for p in box], [p[1] for p in box]
        results.append(
            {
                "text": text,
                "bbox": [min(xs), min(ys), max(xs), max(ys)],
                "confidence": float(score),
                "polygon": box,  # TL, TR, BR, BL
            }
        )
    return {"results": results}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", "8829")))
