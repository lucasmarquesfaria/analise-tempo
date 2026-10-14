"""Ajuda na calibração.

Uso:
  python -m app.calibrate snapshot           # salva /data/calib.jpg com grade de coordenadas
  python -m app.calibrate test [imagem.jpg]  # mostra o nível detectado com a calibração atual
"""
import json
import sys

import cv2

from . import config
from .analyze_river import draw_overlay, estimate_level
from .stream import grab_frame


def grid(img, step=50):
    out = img.copy()
    h, w = out.shape[:2]
    for x in range(0, w, step):
        cv2.line(out, (x, 0), (x, h), (255, 255, 255), 1 if x % 200 else 2)
        if x % 100 == 0:
            cv2.putText(out, str(x), (x + 2, 14), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
    for y in range(0, h, step):
        cv2.line(out, (0, y), (w, y), (255, 255, 255), 1 if y % 200 else 2)
        if y % 100 == 0:
            cv2.putText(out, str(y), (2, y - 2), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 255, 255), 1)
    return out


def main():
    config.ensure_dirs()
    cmd = sys.argv[1] if len(sys.argv) > 1 else "snapshot"
    if cmd == "snapshot":
        raw = config.DATA_DIR / "calib_raw.jpg"
        grab_frame(raw)
        img = cv2.imread(str(raw))
        cv2.imwrite(str(config.DATA_DIR / "calib.jpg"), grid(img))
        print(f"Imagem {img.shape[1]}x{img.shape[0]} salva em {config.DATA_DIR}/calib.jpg")
        print("Abra, escolha a régua e a amostra de água e edite", config.CALIBRATION_FILE)
        if not config.CALIBRATION_FILE.exists():
            config.CALIBRATION_FILE.write_text(json.dumps(config.DEFAULT_CALIBRATION, indent=2))
    elif cmd == "test":
        path = sys.argv[2] if len(sys.argv) > 2 else str(config.DATA_DIR / "calib_raw.jpg")
        img = cv2.imread(path)
        cal = config.load_calibration()
        if img is None:
            sys.exit(f"Não consegui abrir {path}")
        r = estimate_level(img, cal)
        cv2.imwrite(str(config.DATA_DIR / "calib_test.jpg"), draw_overlay(img, cal, r))
        print(json.dumps(r, indent=2), f"\nResultado em {config.DATA_DIR}/calib_test.jpg")


if __name__ == "__main__":
    main()
