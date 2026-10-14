"""Histórico em SQLite."""
import json
import sqlite3
from contextlib import contextmanager
from datetime import datetime

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,                 -- ISO local
    snapshot TEXT,
    level_pct REAL, level_m REAL, level_conf REAL,
    pessoas INTEGER, carros INTEGER, motos INTEGER, onibus INTEGER,
    caminhoes INTEGER, bicicletas INTEGER, movimento_pct REAL,
    periodo TEXT, visibilidade TEXT, brilho REAL, contraste REAL,
    temp_c REAL, chuva_agora_mm REAL, chuva_24h_mm REAL, chuva_prox_6h_mm REAL,
    condicao TEXT, ia_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_readings_ts ON readings(ts);
CREATE TABLE IF NOT EXISTS alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, kind TEXT, message TEXT
);
-- CEMADEN: horários já convertidos para o horário local, como em readings
CREATE TABLE IF NOT EXISTS cemaden_estacao (
    id INTEGER PRIMARY KEY, codigo TEXT, nome TEXT, tipo TEXT, cidade TEXT, uf TEXT,
    lat REAL, lon REAL, dist_km REAL, offset_m REAL,
    cota_atencao REAL, cota_alerta REAL, cota_transbordamento REAL
);
CREATE TABLE IF NOT EXISTS cemaden_nivel (
    est INTEGER NOT NULL, ts TEXT NOT NULL, nivel_m REAL, distancia_m REAL, qualif TEXT,
    PRIMARY KEY (est, ts)
);
CREATE TABLE IF NOT EXISTS cemaden_chuva (
    est INTEGER NOT NULL, ts TEXT NOT NULL, mm REAL,
    PRIMARY KEY (est, ts)
);
CREATE TABLE IF NOT EXISTS cemaden_meta (k TEXT PRIMARY KEY, v TEXT);
"""


@contextmanager
def conn():
    c = sqlite3.connect(config.DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        yield c
        c.commit()
    finally:
        c.close()


def init():
    with conn() as c:
        c.executescript(SCHEMA)


def insert_reading(r: dict) -> None:
    cols = [
        "ts", "snapshot", "level_pct", "level_m", "level_conf", "pessoas", "carros", "motos",
        "onibus", "caminhoes", "bicicletas", "movimento_pct", "periodo", "visibilidade",
        "brilho", "contraste", "temp_c", "chuva_agora_mm", "chuva_24h_mm",
        "chuva_prox_6h_mm", "condicao", "ia_json",
    ]
    row = {k: r.get(k) for k in cols}
    if isinstance(row["ia_json"], dict):
        row["ia_json"] = json.dumps(row["ia_json"], ensure_ascii=False)
    with conn() as c:
        c.execute(
            f"INSERT INTO readings ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
            [row[k] for k in cols],
        )


# como juntar várias leituras num ponto só (gráficos de 7 dias não precisam de 10 mil linhas)
_AVG = ("level_pct", "level_m", "level_conf", "movimento_pct", "brilho", "contraste", "temp_c")
_MAX = ("pessoas", "carros", "motos", "onibus", "caminhoes", "bicicletas",
        "chuva_agora_mm", "chuva_24h_mm", "chuva_prox_6h_mm")
_LAST = ("periodo", "visibilidade", "condicao")


def _downsample(rows: list[dict], hours: int, points: int) -> list[dict]:
    if len(rows) <= points:
        return rows
    span = hours * 3600 / points
    groups: dict[int, list[dict]] = {}
    for r in rows:
        groups.setdefault(int(datetime.fromisoformat(r["ts"]).timestamp() // span), []).append(r)
    out = []
    for k in sorted(groups):
        g = groups[k]
        row = {"ts": g[-1]["ts"]}
        for col in _AVG:
            v = [r[col] for r in g if r[col] is not None]
            row[col] = round(sum(v) / len(v), 2) if v else None
        for col in _MAX:  # contagens e chuva: o pico do intervalo
            v = [r[col] for r in g if r[col] is not None]
            row[col] = max(v) if v else None
        for col in _LAST:
            row[col] = g[-1][col]
        out.append(row)
    return out


def recent(hours: int = 24, points: int | None = None) -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT * FROM readings WHERE ts >= datetime('now','localtime', ?) ORDER BY ts",
            (f"-{int(hours)} hours",),
        ).fetchall()
    rows = [dict(r) for r in rows]
    return _downsample(rows, hours, points) if points else rows


def latest() -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM readings ORDER BY id DESC LIMIT 1").fetchone()
    return dict(r) if r else None


def level_series(minutes: int) -> list[tuple[str, float]]:
    with conn() as c:
        rows = c.execute(
            "SELECT ts, level_pct FROM readings WHERE level_pct IS NOT NULL "
            "AND ts >= datetime('now','localtime', ?) ORDER BY ts",
            (f"-{int(minutes)} minutes",),
        ).fetchall()
    return [(r["ts"], r["level_pct"]) for r in rows]


def last_alert(kind: str) -> str | None:
    with conn() as c:
        r = c.execute("SELECT ts FROM alerts WHERE kind=? ORDER BY id DESC LIMIT 1", (kind,)).fetchone()
    return r["ts"] if r else None


def add_alert(ts: str, kind: str, message: str) -> None:
    with conn() as c:
        c.execute("INSERT INTO alerts (ts, kind, message) VALUES (?,?,?)", (ts, kind, message))


def alerts(limit: int = 20) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT * FROM alerts ORDER BY id DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


# ── CEMADEN ──────────────────────────────────────────────────────────────────
def cemaden_save_estacoes(sts: list[dict]) -> None:
    cols = ("id", "codigo", "nome", "tipo", "cidade", "uf", "lat", "lon", "dist_km", "offset_m",
            "cota_atencao", "cota_alerta", "cota_transbordamento")
    with conn() as c:
        c.execute("DELETE FROM cemaden_estacao")
        c.executemany(f"INSERT INTO cemaden_estacao ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})",
                      [[s.get(k) for k in cols] for s in sts])


def cemaden_estacoes() -> list[dict]:
    with conn() as c:
        return [dict(r) for r in c.execute("SELECT * FROM cemaden_estacao ORDER BY dist_km")]


def cemaden_save_nivel(est: int, rows: list[tuple]) -> None:
    with conn() as c:
        c.executemany("INSERT OR REPLACE INTO cemaden_nivel (est, ts, nivel_m, distancia_m, qualif) "
                      "VALUES (?,?,?,?,?)", [(est, *r) for r in rows])


def cemaden_save_chuva(est: int, rows: list[tuple]) -> None:
    with conn() as c:
        c.executemany("INSERT OR REPLACE INTO cemaden_chuva (est, ts, mm) VALUES (?,?,?)",
                      [(est, *r) for r in rows])


def cemaden_nivel_since(est: int, hours: float) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT ts, nivel_m FROM cemaden_nivel WHERE est=? AND nivel_m IS NOT NULL "
                         "AND ts >= datetime('now','localtime', ?) ORDER BY ts",
                         (est, f"-{float(hours)} hours")).fetchall()
    return [dict(r) for r in rows]


def cemaden_chuva_since(est: int, hours: float) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT ts, mm FROM cemaden_chuva WHERE est=? AND mm IS NOT NULL "
                         "AND ts >= datetime('now','localtime', ?) ORDER BY ts",
                         (est, f"-{float(hours)} hours")).fetchall()
    return [dict(r) for r in rows]


def cemaden_meta_set(k: str, v: str | None) -> None:
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO cemaden_meta (k, v) VALUES (?,?)", (k, v))


def cemaden_meta(k: str) -> str | None:
    with conn() as c:
        r = c.execute("SELECT v FROM cemaden_meta WHERE k=?", (k,)).fetchone()
    return r["v"] if r else None
