# RapidOCR service for LiteParse. Only needed when `ocrUrl` points at it; scale it on its own (CPU only).
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# importing the server builds the engine, which downloads the ONNX models now, not when a container starts
COPY server.py .
RUN python -c "import server"
EXPOSE 8829
HEALTHCHECK CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8829/health')"
CMD ["python", "server.py"]
