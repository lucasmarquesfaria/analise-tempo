"""Estimativa do nível do rio por visão computacional.

Ideia: você marca uma "régua" vertical num ponto onde a água encosta numa
parede, pilar ou barranco, e um retângulo que é sempre água. Para cada linha
da régua comparamos a cor (espaço Lab) com a amostra de água. A linha d'água é
o ponto, de baixo para cima, onde a imagem deixa de parecer água.
"""
from __future__ import annotations

import base64
import json
import logging
import re
from collections import deque

import cv2
import numpy as np

log = logging.getLogger(__name__)


def _water_stats(lab: np.ndarray, s: dict) -> tuple[np.ndarray, float]:
    roi = lab[s["y"]: s["y"] + s["h"], s["x"]: s["x"] + s["w"]].reshape(-1, 3)
    mean = roi.mean(axis=0)
    spread = float(np.linalg.norm(roi - mean, axis=1).mean()) + 1e-6
    return mean, spread


def estimate_level(img: np.ndarray, cal: dict) -> dict:
    g, s = cal["gauge"], cal["water_sample"]
    h, w = img.shape[:2]
    lab = cv2.cvtColor(cv2.GaussianBlur(img, (5, 5), 0), cv2.COLOR_BGR2LAB).astype(np.float32)

    water_mean, spread = _water_stats(lab, s)

    x0 = max(0, g["x"] - g["width"] // 2)
    x1 = min(w, g["x"] + g["width"] // 2)
    y_top, y_bot = max(0, g["y_top"]), min(h - 1, g["y_bottom"])
    strip = lab[y_top: y_bot + 1, x0:x1]
    row_mean = strip.mean(axis=1)                       # (linhas, 3)
    dist = np.linalg.norm(row_mean - water_mean, axis=1)  # distância de cor
    # textura: água tende a ser mais lisa na horizontal que concreto/vegetação
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)[y_top: y_bot + 1, x0:x1].astype(np.float32)
    texture = np.abs(np.diff(gray, axis=1)).mean(axis=1) if gray.shape[1] > 1 else np.zeros(len(dist))

    threshold = max(12.0, 3.0 * spread)
    is_water = dist < threshold

    # varre de baixo para cima até achar 6 linhas seguidas que não são água
    run, water_line = 0, None
    for i in range(len(is_water) - 1, -1, -1):
        if is_water[i]:
            run = 0
            water_line = i
        else:
            run += 1
            if run >= 6 and water_line is not None:
                break
    if water_line is None:
        water_line = len(is_water) - 1  # nenhuma água na régua → nível mínimo

    span = max(1, y_bot - y_top)
    level_pct = float(np.clip((len(is_water) - 1 - water_line) / span * 100, 0, 100))
    below = is_water[water_line:]
    confidence = float(below.mean()) if len(below) else 0.0

    brightness = float(cv2.cvtColor(img, cv2.COLOR_BGR2HSV)[..., 2].mean())
    if brightness < 40:
        # noite sem iluminação: cor não distingue água de muro → não chuta valor
        return {"level_pct": None, "water_line_y": None, "confidence": 0.0,
                "motivo": "escuro demais para leitura por cor"}

    result = {
        "level_pct": round(level_pct, 1),
        "water_line_y": int(y_top + water_line),
        "confidence": round(confidence, 2),
        "texture_at_line": round(float(texture[min(water_line, len(texture) - 1)]), 2),
    }
    m = cal.get("meters")
    if m and len(m) == 2:
        (p0, m0), (p1, m1) = (m[0]["pct"], m[0]["m"]), (m[1]["pct"], m[1]["m"])
        result["level_m"] = round(m0 + (level_pct - p0) * (m1 - m0) / max(1e-6, p1 - p0), 2)
    return result


class LevelSmoother:
    """Mediana das últimas N leituras.

    Com vários frames por segundo uma leitura isolada oscila (reflexo, onda,
    carro passando na régua); a mediana estabiliza sem atrasar muito.
    """

    def __init__(self, size: int):
        self.buf: deque[dict] = deque(maxlen=max(1, size))

    def update(self, river: dict) -> dict:
        if river.get("level_pct") is None:  # noite: não mistura com leituras antigas
            self.buf.clear()
            return river
        self.buf.append(river)
        med = lambda k: float(np.median([r[k] for r in self.buf]))  # noqa: E731
        out = dict(river)
        out["level_pct"] = round(med("level_pct"), 1)
        out["water_line_y"] = int(med("water_line_y"))
        out["confidence"] = round(float(np.mean([r["confidence"] for r in self.buf])), 2)
        if all("level_m" in r for r in self.buf):
            out["level_m"] = round(med("level_m"), 2)
        return out


def draw_overlay(img: np.ndarray, cal: dict, river: dict) -> np.ndarray:
    out = img.copy()
    g, s = cal["gauge"], cal["water_sample"]
    cv2.rectangle(out, (s["x"], s["y"]), (s["x"] + s["w"], s["y"] + s["h"]), (255, 200, 0), 2)
    cv2.line(out, (g["x"], g["y_top"]), (g["x"], g["y_bottom"]), (0, 255, 255), 2)
    y = river.get("water_line_y")
    if y is None:
        cv2.putText(out, "sem leitura (escuro)", (g["x"] + 10, g["y_top"] + 20),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 255), 2)
        return out
    cv2.line(out, (g["x"] - 40, y), (g["x"] + 40, y), (0, 0, 255), 3)
    label = f"{river['level_pct']}%"
    if "level_m" in river:
        label += f"  ({river['level_m']} m)"
    cv2.putText(out, label, (g["x"] + 48, y + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (0, 0, 255), 2)
    return out


def vision_check(jpeg_bytes: bytes, api_key: str, model: str) -> dict | None:
    """Pede a um modelo de visão uma leitura qualitativa (opcional)."""
    try:
        import anthropic
    except ImportError:
        return None
    client = anthropic.Anthropic(api_key=api_key)
    prompt = (
        "Esta é uma câmera fixa apontada para o Rio Caratinga (MG). Responda SÓ em JSON: "
        '{"situacao": "normal|elevado|transbordando", "nivel_estimado_0a10": <número>, '
        '"chuva_visivel": true|false, "observacao": "<até 20 palavras>"}'
    )
    try:
        msg = client.messages.create(
            model=model,
            max_tokens=300,
            messages=[{
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                 "data": base64.b64encode(jpeg_bytes).decode()}},
                    {"type": "text", "text": prompt},
                ],
            }],
        )
        text = "".join(b.text for b in msg.content if getattr(b, "type", "") == "text")
        match = re.search(r"\{.*\}", text, re.S)
        return json.loads(match.group(0)) if match else None
    except Exception as e:  # nunca derruba o loop por causa da IA
        log.warning("Visão IA falhou: %s", e)
        return None
