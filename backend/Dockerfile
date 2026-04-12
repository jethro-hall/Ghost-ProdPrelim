FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends     build-essential     ca-certificates     libglib2.0-0     libgl1     libsm6     libxext6     libxrender1     libxcb1     && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src

RUN pip install --no-cache-dir --upgrade pip setuptools wheel     && pip install --no-cache-dir "."

ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["python", "-m", "ghostdash_api.main"]
