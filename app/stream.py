"""Descobre a URL .m3u8 por trás do player e captura frames com ffmpeg."""
import logging
import subprocess
import threading
import time
from pathlib import Path

from . import config

log = logging.getLogger(__name__)
_cached_url: str | None = None


def resolve_stream_url(force: bool = False) -> str:
    """Abre o player num Chromium headless e pega a primeira requisição .m3u8."""
    global _cached_url
    if config.STREAM_URL:
        return config.STREAM_URL
    if _cached_url and not force:
        return _cached_url

    from playwright.sync_api import sync_playwright

    found: list[str] = []
    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--autoplay-policy=no-user-gesture-required"])
        page = browser.new_page()
        page.on("request", lambda r: found.append(r.url) if ".m3u8" in r.url else None)
        page.goto(config.PLAYER_URL, wait_until="domcontentloaded", timeout=45_000)
        deadline = time.time() + 30
        while not found and time.time() < deadline:
            # alguns players só carregam o stream depois do clique no play
            try:
                page.mouse.click(640, 360)
            except Exception:
                pass
            page.wait_for_timeout(1500)
        browser.close()

    if not found:
        raise RuntimeError("Não encontrei .m3u8 no player (ele está no ar?)")
    # prefere a playlist principal; chunklist também funciona
    found.sort(key=lambda u: ("chunklist" in u, len(u)))
    _cached_url = found[0]
    log.info("Stream resolvido: %s", _cached_url)
    return _cached_url


def grab_frame(out: Path, retries: int = 2) -> Path:
    """Salva 1 frame JPEG do stream. Renova a URL se o token expirou."""
    for attempt in range(retries + 1):
        url = resolve_stream_url(force=attempt > 0)
        cmd = [
            "ffmpeg", "-y", "-loglevel", "error",
            "-rw_timeout", "20000000",
            "-i", url, "-frames:v", "1", "-q:v", "2", str(out),
        ]
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        if r.returncode == 0 and out.exists() and out.stat().st_size > 0:
            return out
        log.warning("ffmpeg falhou (tentativa %d): %s", attempt + 1, r.stderr.strip()[:300])
    raise RuntimeError("Não consegui capturar frame do stream")


class FrameGrabber(threading.Thread):
    """Mantém um ffmpeg lendo o stream e guarda só o frame mais recente (JPEG).

    Quem consome pega sempre o frame atual e pula os atrasados, então a latência
    não cresce quando a análise é mais lenta que o vídeo.
    """

    def __init__(self, fps: float):
        super().__init__(daemon=True, name="frame-grabber")
        self.fps = fps
        self._cond = threading.Condition()
        self._jpeg: bytes | None = None
        self._seq = 0

    def next_frame(self, last_seq: int, timeout: float = 5.0) -> tuple[int, bytes] | None:
        with self._cond:
            if not self._cond.wait_for(lambda: self._seq != last_seq, timeout):
                return None
            return self._seq, self._jpeg

    def _publish(self, jpeg: bytes) -> None:
        with self._cond:
            self._jpeg = jpeg
            self._seq += 1
            self._cond.notify_all()

    def run(self) -> None:
        failures = 0
        while True:
            try:
                got = self._pump(resolve_stream_url(force=failures > 0))
                failures = 0 if got else failures + 1
            except Exception as e:
                failures += 1
                log.warning("Stream caiu: %s", e)
            time.sleep(min(30, 1 + 2 * failures))  # token expirado → resolve de novo

    def _pump(self, url: str) -> int:
        cmd = [
            "ffmpeg", "-loglevel", "error", "-rw_timeout", "20000000",
            # HLS chega em rajadas (1 segmento de uma vez); -re entrega no ritmo do vídeo.
            # -live_start_index -2 começa 2 segmentos atrás: com -1 o buffer esvazia e o vídeo
            # trava ~2 s a cada troca de segmento; o padrão (-3) é fluido mas mais atrasado.
            "-live_start_index", "-2", "-re",
            "-i", url, "-an", "-vf", f"fps={self.fps}",
            "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "-",
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE)
        frames, buf = 0, b""
        try:
            while chunk := proc.stdout.read1(65536):
                buf += chunk
                while True:  # separa os JPEGs concatenados (SOI ff d8 … EOI ff d9)
                    start = buf.find(b"\xff\xd8")
                    if start < 0:
                        buf = buf[-1:]
                        break
                    end = buf.find(b"\xff\xd9", start + 2)
                    if end < 0:
                        buf = buf[start:]
                        break
                    self._publish(buf[start:end + 2])
                    frames += 1
                    buf = buf[end + 2:]
        finally:
            proc.kill()
            proc.wait()
        return frames
