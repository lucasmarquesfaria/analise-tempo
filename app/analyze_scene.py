"""Movimento (pessoas/veículos) e condição do tempo."""
from __future__ import annotations

import logging

import cv2
import numpy as np
import requests

log = logging.getLogger(__name__)

# classes COCO que interessam
CLASSES = {0: "pessoa", 1: "bicicleta", 2: "carro", 3: "moto", 5: "onibus", 7: "caminhao"}
_model = None


def _yolo(model_name: str):
    global _model
    if _model is None:
        from ultralytics import YOLO
        _model = YOLO(model_name)
    return _model


def count_objects(img: np.ndarray, model_name: str, conf: float, zone: list | None = None) -> dict:
    counts = {v: 0 for v in CLASSES.values()}
    boxes = []
    try:
        res = _yolo(model_name)(img, conf=conf, classes=list(CLASSES), verbose=False)[0]
    except Exception as e:
        log.warning("YOLO indisponível: %s", e)
        return {"counts": counts, "boxes": boxes}
    poly = np.array(zone, np.int32) if zone else None
    for b in res.boxes:
        cls = int(b.cls[0])
        x1, y1, x2, y2 = map(int, b.xyxy[0])
        cx, cy = (x1 + x2) // 2, y2  # ponto do "pé" do objeto
        if poly is not None and cv2.pointPolygonTest(poly, (cx, cy), False) < 0:
            continue
        counts[CLASSES[cls]] += 1
        boxes.append((x1, y1, x2, y2, CLASSES[cls]))
    return {"counts": counts, "boxes": boxes}


def motion_between(prev: np.ndarray | None, cur: np.ndarray) -> float:
    """% de pixels que mudaram desde a captura anterior (atividade geral)."""
    if prev is None or prev.shape != cur.shape:
        return 0.0
    a = cv2.GaussianBlur(cv2.cvtColor(prev, cv2.COLOR_BGR2GRAY), (21, 21), 0)
    b = cv2.GaussianBlur(cv2.cvtColor(cur, cv2.COLOR_BGR2GRAY), (21, 21), 0)
    diff = cv2.threshold(cv2.absdiff(a, b), 25, 255, cv2.THRESH_BINARY)[1]
    return round(float((diff > 0).mean() * 100), 2)


def image_weather(img: np.ndarray) -> dict:
    """Sinais do tempo tirados da própria imagem."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    brightness = float(hsv[..., 2].mean())
    saturation = float(hsv[..., 1].mean())
    contrast = float(gray.std())
    sharpness = float(cv2.Laplacian(gray, cv2.CV_64F).var())

    if brightness < 40:
        periodo = "noite"
    elif brightness < 90:
        periodo = "amanhecer/entardecer"
    else:
        periodo = "dia"

    # neblina/chuva forte: imagem lavada (pouco contraste, pouca nitidez e cor)
    if periodo == "noite":
        visibilidade = "n/d (noite)"
    elif contrast < 35 and sharpness < 80 and saturation < 50:
        visibilidade = "baixa (neblina ou chuva forte)"
    elif periodo != "noite" and contrast < 22:
        visibilidade = "reduzida"
    else:
        visibilidade = "boa"

    return {
        "periodo": periodo,
        "visibilidade": visibilidade,
        "brilho": round(brightness, 1),
        "contraste": round(contrast, 1),
        "nitidez": round(sharpness, 1),
        "saturacao": round(saturation, 1),
    }


WMO = {
    0: "céu limpo", 1: "poucas nuvens", 2: "parcialmente nublado", 3: "nublado",
    45: "neblina", 48: "neblina", 51: "garoa", 53: "garoa", 55: "garoa forte",
    61: "chuva fraca", 63: "chuva", 65: "chuva forte", 80: "pancadas", 81: "pancadas",
    82: "pancadas fortes", 95: "trovoada", 96: "trovoada c/ granizo", 99: "trovoada c/ granizo",
}


def api_weather(lat: float, lon: float) -> dict:
    """Tempo atual e chuva das últimas/próximas horas pelo Open-Meteo (sem chave)."""
    try:
        r = requests.get(
            "https://api.open-meteo.com/v1/forecast",
            params={
                "latitude": lat, "longitude": lon, "timezone": "America/Sao_Paulo",
                "current": "temperature_2m,precipitation,rain,weather_code,cloud_cover",
                "hourly": "precipitation", "past_hours": 24, "forecast_hours": 6,
            },
            timeout=15,
        )
        r.raise_for_status()
        d = r.json()
        cur = d["current"]
        hourly = d["hourly"]["precipitation"]
        return {
            "temp_c": cur.get("temperature_2m"),
            "chuva_agora_mm": cur.get("precipitation"),
            "nuvens_pct": cur.get("cloud_cover"),
            "condicao": WMO.get(cur.get("weather_code"), str(cur.get("weather_code"))),
            "chuva_24h_mm": round(sum(x or 0 for x in hourly[:24]), 1),
            "chuva_prox_6h_mm": round(sum(x or 0 for x in hourly[24:]), 1),
        }
    except Exception as e:
        log.warning("Open-Meteo falhou: %s", e)
        return {}
