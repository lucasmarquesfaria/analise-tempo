"""Configuração via variáveis de ambiente (.env)."""
import json
import os
from pathlib import Path


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).strip().lower() in ("1", "true", "yes", "sim")


PLAYER_URL = os.getenv(
    "PLAYER_URL",
    "https://player.jmvstream.com/ipcam/PsG94AJRDonkpYPM9xNQID9IO8HFva",
)
# Se você já tiver o .m3u8, pode fixar aqui e pular o Playwright
STREAM_URL = os.getenv("STREAM_URL", "").strip()

INTERVAL_SECONDS = int(os.getenv("INTERVAL_SECONDS", "300"))  # gravação no histórico (5 min)

# Tempo real: o vídeo e os números do painel não dependem do histórico acima
LIVE_FPS = float(os.getenv("LIVE_FPS", "5"))                       # quadros/s do vídeo ao vivo
ANALYSIS_INTERVAL_SECONDS = float(os.getenv("ANALYSIS_INTERVAL_SECONDS", "1"))  # YOLO + movimento
LIVE_WIDTH = int(os.getenv("LIVE_WIDTH", "1280"))  # largura do vídeo/snapshot (0 = original)
LEVEL_SMOOTH_FRAMES = int(os.getenv("LEVEL_SMOOTH_FRAMES", "7"))   # mediana do nível
WEATHER_TTL_SECONDS = int(os.getenv("WEATHER_TTL_SECONDS", "300"))  # Open-Meteo
DATA_DIR = Path(os.getenv("DATA_DIR", "/data"))
SNAP_DIR = DATA_DIR / "snapshots"
DB_PATH = DATA_DIR / "rio.db"
CALIBRATION_FILE = DATA_DIR / "calibration.json"
LIVE_FILE = DATA_DIR / "live.json"  # última leitura ao vivo (o worker escreve, o painel lê)
KEEP_SNAPSHOTS_DAYS = int(os.getenv("KEEP_SNAPSHOTS_DAYS", "7"))

# Coordenadas de Caratinga (para o Open-Meteo)
LAT = float(os.getenv("LAT", "-19.789"))
LON = float(os.getenv("LON", "-42.139"))

# CEMADEN (dados abertos, sem chave): nível do rio e chuva das estações perto da câmera
CEMADEN_ENABLED = _bool("CEMADEN_ENABLED", True)
CEMADEN_INTERVAL_SECONDS = int(os.getenv("CEMADEN_INTERVAL_SECONDS", "300"))
CEMADEN_RADIUS_KM = float(os.getenv("CEMADEN_RADIUS_KM", "30"))
CEMADEN_HIDRO_ID = os.getenv("CEMADEN_HIDRO_ID", "").strip()  # vazio = a mais próxima
CEMADEN_PLUVIO_IDS = [x for x in os.getenv("CEMADEN_PLUVIO_IDS", "").replace(" ", "").split(",") if x]
CEMADEN_PLUVIO_MAX = int(os.getenv("CEMADEN_PLUVIO_MAX", "3"))

ENABLE_YOLO = _bool("ENABLE_YOLO", True)
YOLO_MODEL = os.getenv("YOLO_MODEL", "yolov8n.pt")
YOLO_CONF = float(os.getenv("YOLO_CONF", "0.35"))

# IA de visão (opcional) para confirmar o nível do rio
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY", "").strip()
VISION_MODEL = os.getenv("VISION_MODEL", "claude-sonnet-5-5")
VISION_EVERY_N = int(os.getenv("VISION_EVERY_N", "6"))  # 1 a cada N capturas

# Alertas no Telegram (opcional)
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "").strip()
ALERT_LEVEL_PCT = float(os.getenv("ALERT_LEVEL_PCT", "70"))  # % da régua
ALERT_RISE_PCT_PER_HOUR = float(os.getenv("ALERT_RISE_PCT_PER_HOUR", "10"))
ALERT_COOLDOWN_MIN = int(os.getenv("ALERT_COOLDOWN_MIN", "60"))


DEFAULT_CALIBRATION = {
    # Faixa vertical onde a água encosta numa parede/pilar (a "régua")
    "gauge": {"x": 640, "y_top": 200, "y_bottom": 650, "width": 24},
    # Retângulo que é SEMPRE água (referência de cor)
    "water_sample": {"x": 500, "y": 600, "w": 80, "h": 40},
    # Opcional: converter % em metros com dois pontos conhecidos
    # {"pct": 0, "m": 0.5}, {"pct": 100, "m": 4.0}
    "meters": None,
    # Áreas para contagem de pessoas/veículos (vazio = imagem toda)
    "count_zone": None,
}


def load_calibration() -> dict:
    if CALIBRATION_FILE.exists():
        data = json.loads(CALIBRATION_FILE.read_text())
        return {**DEFAULT_CALIBRATION, **data}
    return DEFAULT_CALIBRATION


def ensure_dirs() -> None:
    SNAP_DIR.mkdir(parents=True, exist_ok=True)
