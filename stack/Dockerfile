FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends     ca-certificates     curl     && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY config.yaml /app/config.yaml

RUN pip install --no-cache-dir --upgrade pip setuptools wheel     && pip install --no-cache-dir     llama-stack==0.7.0     qdrant-client     pypdf     chardet

ENV SQLITE_STORE_DIR=/data/llama-stack

EXPOSE 8321

CMD ["llama", "stack", "run", "/app/config.yaml", "--port", "8321"]
