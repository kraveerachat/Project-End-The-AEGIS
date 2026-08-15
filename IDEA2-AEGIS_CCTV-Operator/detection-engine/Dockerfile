FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

# OpenSSH/rsync are installed for the optional verified NAS path. Development
# keeps NAS disabled, so their presence never implies a successful transfer.
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client rsync \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY aegis_engine ./aegis_engine
COPY run.py setup_camera.py README.md .env.example ./

# Runtime files and mount targets are owned by an unprivileged account so camera
# processing never needs root privileges inside the container.
RUN useradd --create-home --uid 10001 aegis \
    && mkdir -p /nas/clips /data/snapshots \
    && chown -R aegis:aegis /app /nas /data

USER aegis

EXPOSE 8077
VOLUME ["/nas/clips", "/data/snapshots"]

HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8077/health', timeout=2)" || exit 1

CMD ["python", "run.py"]
