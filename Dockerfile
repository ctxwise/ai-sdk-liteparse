# Linux image with what LiteParse needs at runtime. Your app image needs the same apt + tessdata lines.
# Build + test: docker build -t ai-sdk-liteparse . && docker run --rm ai-sdk-liteparse
FROM node:24-slim
# LibreOffice converts docx/xlsx/pptx; fonts keep layout and text right; ca-certificates for HTTPS (vision model)
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates fonts-dejavu-core \
    libreoffice-writer libreoffice-calc libreoffice-impress \
 && rm -rf /var/lib/apt/lists/*
# Tesseract language data (what LiteParse would otherwise download on the first OCR); pinned by checksum
ADD --checksum=sha256:8280aed0782fe27257a68ea10fe7ef324ca0f8d85bd2fd145d1c2b560bcb66ba \
    https://github.com/tesseract-ocr/tessdata_best/raw/main/eng.traineddata /usr/share/tessdata/eng.traineddata
ENV TESSDATA_PREFIX=/usr/share/tessdata
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
CMD ["npm", "test"]
