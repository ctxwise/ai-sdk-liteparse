# olmOCR-bench's official scorer, unmodified. No torch/GPU: the bench extra only needs matching libraries.
# docker build -f bench/score.Dockerfile -t olmocr-score bench
# docker run --rm -v ./bench/data/olmOCR-bench/bench_data:/data olmocr-score
FROM python:3.12-slim
RUN pip install --no-cache-dir "olmocr[bench]==0.4.27" numpy matplotlib
ENTRYPOINT ["python", "-m", "olmocr.bench.benchmark", "--dir", "/data"]
