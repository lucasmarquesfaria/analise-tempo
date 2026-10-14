"""Loop principal: stream contínuo → análise ao vivo → painel; histórico em segundo plano."""
import json
import logging
import os
import threading
import time
from datetime import datetime, timedelta
from pathlib import Path

import cv2
import numpy as np

from . import alerts, cemaden, config, db
from .analyze_river import LevelSmoother, draw_overlay, estimate_level, vision_check
from .analyze_scene import api_weather, count_objects, image_weather, motion_between
from .stream import FrameGrabber

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")


def cleanup_old_snapshots() -> None:
    limit = time.time() - config.KEEP_SNAPSHOTS_DAYS * 86400
    for f in config.SNAP_DIR.glob("*.jpg"):
        if f.stat().st_mtime < limit:
            f.unlink(missing_ok=True)


def atomic_write(path: Path, data: bytes) -> None:
    """Escreve num temporário e troca, para o painel nunca ler arquivo pela metade."""
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, path)


class WeatherCache:
    """O Open-Meteo atualiza a cada ~15 min; buscar a cada frame estouraria a cota.

    A busca roda em segundo plano para uma API lenta não congelar o vídeo.
    """

    def __init__(self, ttl: int):
        self.ttl, self.data, self._at, self._busy = ttl, {}, 0.0, False

    def get(self) -> dict:
        if not self._busy and time.time() - self._at > self.ttl:
            self._busy = True
            threading.Thread(target=self._refresh, daemon=True).start()
        return self.data

    def _refresh(self) -> None:
        try:
            fresh = api_weather(config.LAT, config.LON)
            if fresh:  # se a API falhar, mantém o último valor
                self.data = fresh
        finally:
            self._at = time.time()
            self._busy = False


class Recorder:
    """Grava o histórico (snapshot, SQLite, alertas) fora do loop de vídeo.

    A IA de visão e o Telegram são chamadas de rede lentas; se rodassem no loop
    ao vivo, o vídeo congelaria a cada gravação.
    """

    def __init__(self) -> None:
        self.n = 0
        self.last_ia: str | None = None  # última leitura da IA, mostrada no painel ao vivo
        self._busy = threading.Event()

    def submit(self, stamp: str, jpeg: bytes, img: np.ndarray, reading: dict) -> bool:
        if self._busy.is_set():
            return False
        self._busy.set()
        threading.Thread(target=self._run, args=(stamp, jpeg, img, reading), daemon=True).start()
        return True

    def _run(self, stamp: str, jpeg: bytes, img: np.ndarray, reading: dict) -> None:
        try:
            path = config.SNAP_DIR / f"{stamp}.jpg"
            path.write_bytes(jpeg)
            reading["snapshot"] = path.name
            if config.ANTHROPIC_API_KEY and self.n % config.VISION_EVERY_N == 0:
                ok, buf = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok:
                    ia = vision_check(buf.tobytes(), config.ANTHROPIC_API_KEY, config.VISION_MODEL)
                    reading["ia_json"] = ia
                    if ia:
                        self.last_ia = json.dumps(ia, ensure_ascii=False)
            self.n += 1
            db.insert_reading(reading)
            fired = alerts.evaluate(reading, str(path))
            log.info("gravado: nível=%s%% conf=%s pessoas=%s carros=%s mov=%s%% %s/%s %s",
                     reading["level_pct"], reading["level_conf"], reading["pessoas"],
                     reading["carros"], reading["movimento_pct"], reading["periodo"],
                     reading["visibilidade"], ("ALERTA: " + "; ".join(fired)) if fired else "")
        except Exception as e:
            log.error("Falha ao gravar histórico: %s", e)
        finally:
            self._busy.clear()


def render(img: np.ndarray, cal: dict, river: dict, objs: dict, now: datetime) -> np.ndarray:
    out = draw_overlay(img, cal, river)
    for x1, y1, x2, y2, name in objs["boxes"]:
        cv2.rectangle(out, (x1, y1), (x2, y2), (0, 200, 0), 2)
        cv2.putText(out, name, (x1, y1 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 200, 0), 1)
    label = now.strftime("%d/%m/%Y %H:%M:%S")  # prova de que a imagem está atual
    cv2.putText(out, label, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 0, 0), 4)
    cv2.putText(out, label, (12, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (255, 255, 255), 2)
    return out


def make_reading(now: datetime, river: dict, scene: dict, objs: dict, movimento: float,
                 weather: dict) -> dict:
    c = objs["counts"]
    return {
        "ts": now.isoformat(sep=" "),
        "level_pct": river["level_pct"], "level_m": river.get("level_m"),
        "level_conf": river["confidence"],
        "pessoas": c.get("pessoa"), "carros": c.get("carro"), "motos": c.get("moto"),
        "onibus": c.get("onibus"), "caminhoes": c.get("caminhao"), "bicicletas": c.get("bicicleta"),
        "movimento_pct": movimento,
        "periodo": scene["periodo"], "visibilidade": scene["visibilidade"],
        "brilho": scene["brilho"], "contraste": scene["contraste"],
        "temp_c": weather.get("temp_c"), "chuva_agora_mm": weather.get("chuva_agora_mm"),
        "chuva_24h_mm": weather.get("chuva_24h_mm"),
        "chuva_prox_6h_mm": weather.get("chuva_prox_6h_mm"),
        "condicao": weather.get("condicao"),
    }


def main():
    config.ensure_dirs()
    db.init()
    grabber = FrameGrabber(config.LIVE_FPS)
    grabber.start()
    if config.CEMADEN_ENABLED:
        cemaden.Poller().start()
    smoother = LevelSmoother(config.LEVEL_SMOOTH_FRAMES)
    weather, recorder = WeatherCache(config.WEATHER_TTL_SECONDS), Recorder()
    log.info("Ao vivo: %s fps, análise a cada %ss, histórico a cada %ss",
             config.LIVE_FPS, config.ANALYSIS_INTERVAL_SECONDS, config.INTERVAL_SECONDS)

    seq, objs, movimento, ref_img = 0, {"counts": {}, "boxes": []}, 0.0, None
    last_analysis, last_cleanup = 0.0, datetime.min
    next_save = time.time() + 10  # 10 s para o nível estabilizar antes da 1ª gravação

    while True:
        got = grabber.next_frame(seq)
        if got is None:
            log.warning("Sem frames do stream há 5 s")
            continue
        seq, jpeg = got
        try:
            img = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
            if img is None:
                continue
            cal = config.load_calibration()  # recalibrar vale sem reiniciar
            river = smoother.update(estimate_level(img, cal))
            scene = image_weather(img)

            t = time.time()
            if t - last_analysis >= config.ANALYSIS_INTERVAL_SECONDS:
                last_analysis = t
                if config.ENABLE_YOLO:  # a parte cara: roda 1×/s, não a cada frame
                    objs = count_objects(img, config.YOLO_MODEL, config.YOLO_CONF,
                                         cal.get("count_zone"))
                movimento = motion_between(ref_img, img)
                ref_img = img

            now = datetime.now().replace(microsecond=0)
            shown = render(img, cal, river, objs, now)  # analisa em resolução total, mostra menor
            if config.LIVE_WIDTH and shown.shape[1] > config.LIVE_WIDTH:
                h = round(shown.shape[0] * config.LIVE_WIDTH / shown.shape[1])
                shown = cv2.resize(shown, (config.LIVE_WIDTH, h), interpolation=cv2.INTER_AREA)
            ok, buf = cv2.imencode(".jpg", shown, [cv2.IMWRITE_JPEG_QUALITY, 80])
            if not ok:
                continue
            overlay_jpg = buf.tobytes()
            reading = make_reading(now, river, scene, objs, movimento, weather.get())

            atomic_write(config.SNAP_DIR / "latest.jpg", overlay_jpg)
            live = {**reading, "snapshot": "latest.jpg", "ia_json": recorder.last_ia}
            atomic_write(config.LIVE_FILE, json.dumps(live, ensure_ascii=False).encode())

            if time.time() >= next_save and recorder.submit(
                    now.strftime("%Y%m%d_%H%M%S"), overlay_jpg, img, reading):
                next_save = time.time() + config.INTERVAL_SECONDS
            if datetime.now() - last_cleanup > timedelta(hours=6):
                cleanup_old_snapshots()
                last_cleanup = datetime.now()
        except Exception as e:
            log.error("Frame falhou: %s", e)
            time.sleep(1)


if __name__ == "__main__":
    main()
