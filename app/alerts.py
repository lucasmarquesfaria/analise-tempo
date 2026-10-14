"""Regras de alerta e envio pelo Telegram."""
import logging
from datetime import datetime, timedelta

import requests

from . import config, db

log = logging.getLogger(__name__)


def _send_telegram(text: str, photo: str | None = None) -> None:
    if not (config.TELEGRAM_TOKEN and config.TELEGRAM_CHAT_ID):
        return
    base = f"https://api.telegram.org/bot{config.TELEGRAM_TOKEN}"
    try:
        if photo:
            with open(photo, "rb") as f:
                requests.post(f"{base}/sendPhoto", data={"chat_id": config.TELEGRAM_CHAT_ID,
                              "caption": text}, files={"photo": f}, timeout=20)
        else:
            requests.post(f"{base}/sendMessage", data={"chat_id": config.TELEGRAM_CHAT_ID,
                          "text": text}, timeout=20)
    except Exception as e:
        log.warning("Telegram falhou: %s", e)


def _cooldown_ok(kind: str, now: datetime) -> bool:
    last = db.last_alert(kind)
    if not last:
        return True
    return now - datetime.fromisoformat(last) > timedelta(minutes=config.ALERT_COOLDOWN_MIN)


def rise_per_hour() -> float | None:
    """Variação do nível (pontos %) na última hora, usando as pontas da série."""
    s = db.level_series(70)
    if len(s) < 3:
        return None
    t0, v0 = datetime.fromisoformat(s[0][0]), s[0][1]
    t1, v1 = datetime.fromisoformat(s[-1][0]), s[-1][1]
    hours = max((t1 - t0).total_seconds() / 3600, 0.25)
    return round((v1 - v0) / hours, 1)


def evaluate(reading: dict, overlay_path: str | None) -> list[str]:
    now = datetime.fromisoformat(reading["ts"])
    fired = []
    lvl, conf = reading.get("level_pct"), reading.get("level_conf") or 0
    if lvl is None or conf < 0.5:
        return fired  # leitura pouco confiável não dispara alerta

    rise = rise_per_hour()
    chuva = reading.get("chuva_prox_6h_mm") or 0

    rules = [
        ("nivel_alto", lvl >= config.ALERT_LEVEL_PCT,
         f"Rio Caratinga ALTO: {lvl}% da régua"),
        ("subida_rapida", rise is not None and rise >= config.ALERT_RISE_PCT_PER_HOUR,
         f"Rio subindo rápido: +{rise} pontos/h (agora {lvl}%)"),
    ]
    for kind, cond, msg in rules:
        if cond and _cooldown_ok(kind, now):
            if chuva:
                msg += f" · previsão de {chuva} mm nas próximas 6h"
            db.add_alert(reading["ts"], kind, msg)
            _send_telegram("⚠️ " + msg, overlay_path)
            fired.append(msg)
    return fired
