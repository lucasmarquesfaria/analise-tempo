FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 TZ=America/Sao_Paulo
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg tzdata libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
# torch só CPU (bem menor que a versão com CUDA)
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision \
    && pip install -r requirements.txt \
    && playwright install --with-deps chromium \
    && python -c "from ultralytics import YOLO; YOLO('yolov8n.pt')"

COPY app ./app
CMD ["python", "-m", "app.worker"]
