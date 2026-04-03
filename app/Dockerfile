# RAG workflow + LlamaDeploy appserver (llamactl serve)
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
COPY tests ./tests

RUN pip install --no-cache-dir --upgrade pip setuptools wheel \
    && pip install --no-cache-dir uv \
    && pip install --no-cache-dir "."

ENV PYTHONUNBUFFERED=1

EXPOSE 4501

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4501/health')" || exit 1

CMD ["llamactl", "serve", "--host", "0.0.0.0", "--port", "4501", "--no-install", "--no-open-browser", "--no-reload", "--persistence", "memory"]
