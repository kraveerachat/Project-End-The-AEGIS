FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Core is the safe default. Camera nodes that explicitly use the trained
# YOLO+SFace backend build with --build-arg AEGIS_INSTALL_AI=true; model weights
# and biometric templates are mounted at runtime and never copied into images.
ARG AEGIS_INSTALL_AI=false

# OpenSSH/rsync are installed for the optional verified NAS path. Development
# keeps NAS disabled, so their presence never implies a successful transfer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client rsync \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-ai.txt ./
RUN if [ "$AEGIS_INSTALL_AI" = "true" ]; then \
        pip install --no-cache-dir -r requirements-ai.txt; \
    else \
        pip install --no-cache-dir -r requirements.txt; \
    fi

COPY aegis_engine ./aegis_engine
COPY run.py setup_camera.py README.md .env.example ./

RUN useradd --create-home --uid 10001 aegis \
    && mkdir -p /nas/clips /data/snapshots \
    && chown -R aegis:aegis /app /nas /data

USER aegis

EXPOSE 8077
VOLUME ["/nas/clips", "/data/snapshots"]

HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8077/health', timeout=2)" || exit 1

CMD ["python", "run.py"]
