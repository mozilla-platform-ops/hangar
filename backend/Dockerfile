# Stage 1: build the React frontend
FROM node:20-slim AS frontend-builder
WORKDIR /frontend
COPY frontend/package*.json ./
RUN npm ci --prefer-offline
COPY frontend/ ./
RUN npm run build

# Stage 2: build the Python backend
FROM python:3.11-slim AS backend

RUN apt-get update && apt-get install -y --no-install-recommends git && rm -rf /var/lib/apt/lists/*

# Non-root user
RUN useradd --create-home --shell /bin/bash app

WORKDIR /app
COPY backend/requirements.txt .
# requirements.txt is generated from requirements.in and fully hash-pinned;
# --require-hashes is implied by the presence of hashes, but stating it makes the
# guarantee explicit and fails loudly if someone regenerates without hashes.
RUN pip install --no-cache-dir --require-hashes -r requirements.txt

COPY backend/ .

# Copy built frontend so FastAPI can serve the SPA
COPY --from=frontend-builder /frontend/dist /app/frontend/dist

ENV STATIC_DIR=/app/frontend/dist \
    LOG_JSON=true \
    PYTHONUNBUFFERED=1

USER app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD python -c "import urllib.request,os; urllib.request.urlopen(f'http://localhost:{os.environ.get(\"PORT\",8000)}/api/health')"

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1"]
