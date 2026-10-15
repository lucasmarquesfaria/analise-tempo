"""Painel: última imagem, gráficos e alertas."""
import asyncio
import json
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import cemaden, config, db

app = FastAPI(title="Monitor Rio Caratinga")
STATIC = Path(__file__).parent / "static"
INDEX = STATIC / "index.html"
STALE_AFTER = 15  # s sem dado novo do worker → painel mostra "sem sinal"


@app.on_event("startup")
def _start():
    config.ensure_dirs()
    db.init()


app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", response_class=HTMLResponse)
def index():
    # a versão (data da última alteração) vai na URL dos arquivos, então o navegador nunca fica com JS/CSS velho
    v = int(max(f.stat().st_mtime for f in STATIC.rglob("*") if f.is_file()))
    return INDEX.read_text(encoding="utf-8").replace("{{v}}", str(v))


@app.get("/api/latest")
def api_latest():
    return db.latest() or {}


@app.get("/api/readings")
def api_readings(hours: int = 24, points: int | None = None):
    """`points` agrega o período em no máximo N pontos (o painel usa para gráficos)."""
    pts = min(max(points, 20), 2000) if points else None
    return db.recent(min(max(hours, 1), 24 * 30), pts)


@app.get("/api/config")
def api_config():
    """Limites e recursos ligados, para o painel mostrar o contexto certo (sem segredos)."""
    return {
        "alert_level_pct": config.ALERT_LEVEL_PCT,
        "alert_rise_pct_per_hour": config.ALERT_RISE_PCT_PER_HOUR,
        "interval_seconds": config.INTERVAL_SECONDS,
        "live_fps": config.LIVE_FPS,
        "yolo": config.ENABLE_YOLO,
        "vision": bool(config.ANTHROPIC_API_KEY),
        "telegram": bool(config.TELEGRAM_TOKEN and config.TELEGRAM_CHAT_ID),
        "cemaden": config.CEMADEN_ENABLED,
        "cemaden_interval_seconds": config.CEMADEN_INTERVAL_SECONDS,
        "lat": config.LAT, "lon": config.LON,
    }


@app.get("/api/cemaden")
def api_cemaden():
    """Nível do rio (estação hidrológica) e chuva dos pluviômetros do CEMADEN, já filtrados."""
    return cemaden.summary()


@app.get("/api/cemaden/zones")
def api_cemaden_zones(days: int = 7):
    """Tempo (minutos) em cada faixa de cota, por dia e no total."""
    return cemaden.zones(days)


@app.get("/api/cemaden/series")
def api_cemaden_series(hours: int = 24, est: int | None = None):
    return cemaden.series(hours, est)


@app.get("/api/alerts")
def api_alerts():
    return db.alerts()


@app.get("/snap/{name}")
def snap(name: str):
    path = (config.SNAP_DIR / name).resolve()
    if path.parent != config.SNAP_DIR.resolve() or not path.exists():
        raise HTTPException(404)
    return FileResponse(path, headers={"Cache-Control": "no-store"})


@app.get("/live.mjpg")
async def live_video(request: Request):
    """Vídeo ao vivo: manda cada frame novo que o worker grava em latest.jpg."""
    latest = config.SNAP_DIR / "latest.jpg"

    async def frames():
        last, data, sent = None, b"", 0.0
        yield b"--frame\r\n"
        while not await request.is_disconnected():
            try:
                mtime = latest.stat().st_mtime_ns
                changed = mtime != last
                # sem frame novo (câmera fora do ar), reenvia o último a cada 1 s: o navegador só
                # mostra uma parte quando a seguinte chega, senão a imagem ficaria preta
                if changed or (data and time.time() - sent > 1.0):
                    if changed:
                        last, data = mtime, latest.read_bytes()
                    sent = time.time()
                    yield (b"Content-Type: image/jpeg\r\nContent-Length: %d\r\n\r\n"
                           % len(data)) + data + b"\r\n--frame\r\n"
                    continue
            except FileNotFoundError:
                pass
            await asyncio.sleep(0.05)

    return StreamingResponse(frames(), media_type="multipart/x-mixed-replace; boundary=frame",
                             headers={"Cache-Control": "no-store"})


@app.get("/api/live.json")
def live_snapshot():
    """Última leitura ao vivo em uma requisição curta.

    O painel usa isto em vez de SSE/MJPEG: conexões permanentes esgotam o limite de 6 por site do
    navegador e, com algumas abas abertas, travam tudo. `_age` é a idade do dado, em segundos.
    """
    try:
        st = config.LIVE_FILE.stat()
        d = json.loads(config.LIVE_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, ValueError, OSError):
        return {}
    d["_age"] = round(max(0.0, time.time() - st.st_mtime), 1)
    d["_stale"] = d["_age"] > STALE_AFTER
    return d


@app.get("/api/live")
async def live_data(request: Request):
    """Server-Sent Events: uma mensagem a cada leitura nova; `stale` se o worker parar."""
    async def events():
        last, sent_at, stale = None, 0.0, False
        while not await request.is_disconnected():
            try:
                st = config.LIVE_FILE.stat()
            except FileNotFoundError:
                st = None
            if st and st.st_mtime_ns != last:
                last = st.st_mtime_ns
                try:
                    payload = config.LIVE_FILE.read_text(encoding="utf-8")
                except OSError:
                    payload = ""
                if payload:
                    yield f"data: {payload}\n\n"
                    sent_at, stale = time.time(), False
            elif st and not stale and time.time() - st.st_mtime > STALE_AFTER:
                stale = True
                yield "event: stale\ndata: {}\n\n"
            elif time.time() - sent_at > 15:
                sent_at = time.time()
                yield ": ping\n\n"
            await asyncio.sleep(0.25)

    return StreamingResponse(events(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
