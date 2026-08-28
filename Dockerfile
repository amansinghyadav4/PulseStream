# syntax=docker/dockerfile:1
# PulseStream backend production image (Phase 8).
# One image serves api and both workers; commands differ per compose service.

# ---- build stage: resolve dependencies into an isolated venv -----------------
FROM python:3.13-slim AS builder
ENV PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /build
COPY requirements.txt .
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install --upgrade pip \
 && /opt/venv/bin/pip install -r requirements.txt

# ---- runtime stage -----------------------------------------------------------
FROM python:3.13-slim
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH="/opt/venv/bin:$PATH"

# Non-root runtime user
RUN groupadd -r pulsestream && useradd -r -g pulsestream pulsestream

COPY --from=builder /opt/venv /opt/venv

WORKDIR /app
COPY app/ ./app/
COPY worker/ ./worker/
COPY scripts/ ./scripts/

USER pulsestream
EXPOSE 8000

# Liveness probe baked in; compose may override per service (workers use the
# Redis-heartbeat script instead of HTTP).
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=3).status == 200 else 1)" || exit 1

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
