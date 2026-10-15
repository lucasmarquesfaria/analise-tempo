"""Dados abertos do CEMADEN: nível do rio (estação hidrológica) e chuva (pluviômetros).

Sem chave nem cadastro: são os mesmos arquivos que o Mapa Interativo do CEMADEN lê.
Os horários chegam em UTC e são gravados no horário local do servidor, como as leituras
da câmera, para tudo ficar na mesma linha do tempo.

Sobre o nível: a estação mede a distância sensor→água, e o nível é `offset - distância`
(mesma conta do gráfico do CEMADEN). Esse sensor oscila bastante (saltos de ~1 m entre
leituras de 10 min, sem chuva), então o nível "oficial" aqui é a mediana da última hora,
acompanhada de um indicador de estabilidade. Cotas vêm da própria estação.
"""
from __future__ import annotations

import json
import logging
import math
import os
import re
import statistics
import threading
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import requests

from . import config, db

log = logging.getLogger("cemaden")

DADOS = "https://resources.cemaden.gov.br/dados"
MEDIDA = "https://resources.cemaden.gov.br/graficos/cemaden/hidro/resources/json/MedidaResource.php"
HORARIO = "https://mapservices.cemaden.gov.br/MapaInterativoWS/resources/horario"
TZ = ZoneInfo(os.getenv("TZ", "America/Sao_Paulo"))

JANELA_MIN = 60          # janela da mediana do nível
ESTAVEL_M = 0.5          # amplitude (p90 - p10) máxima na janela para considerar o sensor estável
DEFASADO_MIN = 90        # sem leitura há mais que isso → "sem dado"
ACC_HORAS = (1, 3, 6, 12, 24, 48, 72, 96)


# ───────────────────────── coleta ─────────────────────────
def _get(url: str, params: dict | None = None) -> requests.Response:
    r = requests.get(url, params=params, timeout=30, headers={"User-Agent": "rio-monitor/1.0"})
    r.raise_for_status()
    return r


def _jsonp(text: str):
    m = re.match(r"^\s*\w+\((.*)\)\s*;?\s*$", text, re.S)
    return json.loads(m.group(1) if m else text)


def _km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p = math.pi / 180
    x = (lon2 - lon1) * p * math.cos((lat1 + lat2) / 2 * p)
    return 6371 * math.hypot(x, (lat2 - lat1) * p)


def _local(utc: datetime) -> str:
    return utc.replace(tzinfo=timezone.utc).astimezone(TZ).replace(tzinfo=None).isoformat(sep=" ")


def _stations(fname: str) -> list[dict]:
    return [e for b in _jsonp(_get(f"{DADOS}/{fname}").text) for e in b.get("estacao", [])]


def discover() -> list[dict]:
    """A estação hidrológica e os pluviômetros mais próximos da câmera (status 0 = ativa)."""
    lat, lon, raio = config.LAT, config.LON, config.CEMADEN_RADIUS_KM

    def build(e: dict, tipo: str) -> dict:
        return {
            "id": e["idestacao"], "codigo": e["codestacao"], "nome": e["nomeestacao"], "tipo": tipo,
            "cidade": e.get("cidade"), "uf": e.get("uf"), "lat": e["latitude"], "lon": e["longitude"],
            "dist_km": round(_km(lat, lon, e["latitude"], e["longitude"]), 2),
            "offset_m": e.get("offset"), "cota_atencao": e.get("cotaatencao"),
            "cota_alerta": e.get("cotaalerta"), "cota_transbordamento": e.get("cotatransbordamento"),
        }

    def perto(es: list[dict]) -> list[dict]:
        ok = [e for e in es if e.get("status") == 0 and e.get("latitude") is not None]
        return sorted((e for e in ok if _km(lat, lon, e["latitude"], e["longitude"]) <= raio),
                      key=lambda e: _km(lat, lon, e["latitude"], e["longitude"]))

    hidro_all, pluvio_all = _stations("327mi_24.json"), _stations("311_24.json")
    out: list[dict] = []
    if config.CEMADEN_HIDRO_ID:
        hs = [e for e in hidro_all if str(e["idestacao"]) == config.CEMADEN_HIDRO_ID]
    else:
        hs = perto(hidro_all)[:1]
    out += [build(e, "hidro") for e in hs]

    seen = {s["id"] for s in out}   # a estação do rio aparece nos dois arquivos
    if config.CEMADEN_PLUVIO_IDS:
        ps = [e for e in pluvio_all if str(e["idestacao"]) in config.CEMADEN_PLUVIO_IDS]
    else:
        ps = [e for e in perto(pluvio_all) if e["idestacao"] not in seen][:config.CEMADEN_PLUVIO_MAX]
    out += [build(e, "pluvio") for e in ps if e["idestacao"] not in seen]
    # a estação hidrológica também tem pluviômetro: entra na lista de chuva
    for h in (s for s in out if s["tipo"] == "hidro"):
        out.append({**h, "tipo": "pluvio_hidro"})
    return out


def fetch_nivel(est: int, offset: float | None, horas: int) -> list[tuple]:
    """(ts_local, nivel_m, distancia_m, qualificação). O servidor guarda ~4 dias."""
    d = _get(MEDIDA, {"est": est, "sen": 20, "pag": horas}).json()
    if not isinstance(d, list):
        return []
    rows = []
    for x in d:
        if x.get("valor") in (None, "") or "datahora" not in x:
            continue
        off = float(x["offset"]) if x.get("offset") not in (None, "") else (offset or 0.0)
        dist = float(x["valor"])
        rows.append((_local(datetime.fromisoformat(x["datahora"])), round(off - dist, 3), dist,
                     x.get("qualificacao")))
    return rows


def fetch_chuva(est: int, horas: int) -> list[tuple]:
    """(ts_local da hora cheia, mm). Cada coluna é uma hora, contada desde o início da janela."""
    s = _get(f"{HORARIO}/{est}/{horas - 1}").json()
    datas, horarios, acum = s.get("datas") or [], s.get("horarios") or [], s.get("acumulados") or []
    if not datas or not horarios:
        return []
    inicio = datetime.strptime(datas[0], "%d/%m/%Y") + timedelta(hours=int(horarios[0].rstrip("h")))
    rows = []
    for j in range(len(horarios)):
        v = next((a[j] for a in acum if j < len(a) and a[j] is not None), None)
        if v is not None:
            rows.append((_local(inicio + timedelta(hours=j)), float(v)))
    return rows


class Poller(threading.Thread):
    """Busca o CEMADEN em segundo plano; falha de rede nunca derruba o worker."""

    def __init__(self) -> None:
        super().__init__(daemon=True, name="cemaden")
        self.stations: list[dict] = []
        self._discovered = 0.0

    def run(self) -> None:
        backfill = True
        while True:
            try:
                self.poll(backfill)
                backfill = False
            except Exception as e:
                log.warning("CEMADEN indisponível: %s", e)
                db.cemaden_meta_set("last_error", f"{datetime.now():%Y-%m-%d %H:%M:%S} {e}"[:300])
            time.sleep(config.CEMADEN_INTERVAL_SECONDS)

    def poll(self, backfill: bool) -> None:
        if not self.stations or time.time() - self._discovered > 86400:
            self.stations = discover()
            self._discovered = time.time()
            db.cemaden_save_estacoes([s for s in self.stations if s["tipo"] != "pluvio_hidro"])
            log.info("CEMADEN: %s", ", ".join(f"{s['nome']} ({s['tipo']}, {s['dist_km']} km)"
                                              for s in self.stations if s["tipo"] != "pluvio_hidro"))
        erros = []
        for s in self.stations:
            try:
                if s["tipo"] == "hidro":
                    db.cemaden_save_nivel(s["id"], fetch_nivel(s["id"], s["offset_m"], 168 if backfill else 12))
                else:
                    db.cemaden_save_chuva(s["id"], fetch_chuva(s["id"], 168 if backfill else 12))
            except Exception as e:
                erros.append(f"{s['nome']}: {e}")
        if erros and len(erros) == len(self.stations):
            raise RuntimeError("; ".join(erros))
        db.cemaden_meta_set("last_ok", f"{datetime.now():%Y-%m-%d %H:%M:%S}")
        db.cemaden_meta_set("last_error", "; ".join(erros) or None)


# ───────────────────────── leitura (painel) ─────────────────────────
def _pct(xs: list[float], p: float) -> float:
    s = sorted(xs)
    i = (len(s) - 1) * p
    lo = int(i)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (i - lo)


def _t(ts: str) -> datetime:
    return datetime.fromisoformat(ts)


def _janela_lo(ts: list, i: int) -> int:
    """Início da janela da mediana para a leitura i.

    São as leituras da última hora; se a fonte estiver publicando de hora em hora e sobrarem
    menos de 3, usa as 3 últimas desde que caibam em 3 h (senão fica a janela curta).
    """
    lo = i
    while lo > 0 and ts[i] - ts[lo - 1] <= timedelta(minutes=JANELA_MIN):
        lo -= 1
    if i - lo + 1 >= 3:
        return lo
    lo3 = max(0, i - 2)
    return lo3 if i - lo3 + 1 >= 3 and ts[i] - ts[lo3] <= timedelta(minutes=180) else lo


def assess_nivel(rows: list[dict], est: dict, now: datetime) -> dict:
    """Mediana da última hora + estabilidade + classe pelas cotas da estação."""
    cotas = {"atencao": est.get("cota_atencao"), "alerta": est.get("cota_alerta"),
             "transbordamento": est.get("cota_transbordamento")}
    out = {"cotas": cotas, "ultimo": None, "nivel_m": None, "variacao_m": None, "n": 0, "janela_min": None,
           "estavel": False, "poucas": False, "classe": None, "idade_min": None, "defasado": True}
    if not rows:
        return out
    ts = [_t(r["ts"]) for r in rows]
    i = len(rows) - 1
    lo = _janela_lo(ts, i)
    janela = [r["nivel_m"] for r in rows[lo:]]
    idade = max(0, round((now - ts[i]).total_seconds() / 60))
    out.update(ultimo={"ts": rows[i]["ts"], "nivel_m": rows[i]["nivel_m"]}, n=len(janela), idade_min=idade,
               defasado=idade > DEFASADO_MIN, janela_min=round((ts[i] - ts[lo]).total_seconds() / 60))
    med = statistics.median(janela)
    out["nivel_m"] = round(med, 2)                      # sempre há um número para mostrar
    if len(janela) < 3:                                 # poucas leituras: mostra, mas não classifica
        out.update(poucas=True, variacao_m=round(max(janela) - min(janela), 2) if len(janela) > 1 else None)
        return out
    var = _pct(janela, .9) - _pct(janela, .1)
    classe = "normal"
    for nome in ("atencao", "alerta", "transbordamento"):
        if cotas[nome] is not None and med >= cotas[nome]:
            classe = nome
    out.update(variacao_m=round(var, 2), estavel=var <= ESTAVEL_M, classe=classe)
    return out


def windows(rows: list[dict], now: datetime) -> dict:
    """Chuva acumulada nas últimas N horas (None quando faltam dados demais)."""
    corte = now.replace(minute=0, second=0, microsecond=0)
    out = {}
    for n in ACC_HORAS:
        ini = corte - timedelta(hours=n - 1)
        v = [r["mm"] for r in rows if _t(r["ts"]) >= ini]
        out[str(n)] = round(sum(v), 1) if len(v) >= max(1, math.ceil(n * 0.5)) else None
    return out


def summary() -> dict:
    if not config.CEMADEN_ENABLED:
        return {"enabled": False}
    now = datetime.now()
    out = {"enabled": True, "atualizado": db.cemaden_meta("last_ok"), "erro": db.cemaden_meta("last_error"),
           "hidro": None, "pluvios": []}
    ests = db.cemaden_estacoes()
    for e in ests:
        base = {k: e[k] for k in ("id", "codigo", "nome", "cidade", "uf", "dist_km")}
        if e["tipo"] == "hidro":
            out["hidro"] = {**base, "lat": e["lat"], "lon": e["lon"],
                            **assess_nivel(db.cemaden_nivel_since(e["id"], 24), e, now)}
    # pluviômetros: os próprios + a chuva da estação hidrológica
    for e in ests:
        rows = db.cemaden_chuva_since(e["id"], 96)
        ultimo = rows[-1]["ts"] if rows else None
        rotulo = e["nome"] if e["tipo"] != "hidro" else f"{e['nome']} (estação do rio)"
        out["pluvios"].append({"id": e["id"], "nome": rotulo, "dist_km": e["dist_km"], "lat": e["lat"], "lon": e["lon"],
                               "acc": windows(rows, now), "ultimo": ultimo})
    out["pluvios"].sort(key=lambda p: p["dist_km"])
    return out


def _rotulo(e: dict) -> str:
    return e["nome"] if e["tipo"] != "hidro" else f"{e['nome']} (estação do rio)"


def series(hours: int, est: int | None = None) -> dict:
    """Nível bruto + mediana móvel de 1 h e chuva horária de um pluviômetro (o mais próximo com dado)."""
    hours = min(max(hours, 1), 24 * 30)
    ests = db.cemaden_estacoes()
    hidro = next((e for e in ests if e["tipo"] == "hidro"), None)
    out = {"nivel": [], "chuva": [], "pluvio": None, "pluvio_id": None, "hidro": None,
           "pluvios": [{"id": e["id"], "nome": _rotulo(e), "dist_km": e["dist_km"]} for e in ests]}
    if hidro:
        rows = db.cemaden_nivel_since(hidro["id"], hours + 1)
        ts = [_t(r["ts"]) for r in rows]
        for i, r in enumerate(rows):
            w = [x["nivel_m"] for x in rows[_janela_lo(ts, i):i + 1]]
            r["filtrado"] = round(statistics.median(w), 2) if len(w) >= 3 else None
        corte = datetime.now() - timedelta(hours=hours)
        out["nivel"] = [r for r in rows if _t(r["ts"]) >= corte]
        out["hidro"] = {"nome": hidro["nome"], "cotas": {"atencao": hidro["cota_atencao"], "alerta": hidro["cota_alerta"],
                                                        "transbordamento": hidro["cota_transbordamento"]}}
    escolhido = next((e for e in ests if e["id"] == est), None) if est else None
    ordem = [escolhido] if escolhido else ([e for e in ests if e["tipo"] != "hidro"] + [e for e in ests if e["tipo"] == "hidro"])
    for e in ordem:   # o mais próximo que tem dado recente
        rows = db.cemaden_chuva_since(e["id"], hours + 1)
        if rows and (escolhido or _t(rows[-1]["ts"]) >= datetime.now() - timedelta(hours=12)):
            out["chuva"], out["pluvio"], out["pluvio_id"] = rows, _rotulo(e), e["id"]
            break
    return out


# ───────────────────────── tempo em cada faixa ─────────────────────────
CATEGORIAS = ("normal", "atencao", "alerta", "transbordamento", "incerto")
GAP_MAX_MIN = 30   # sem leitura por mais que isso, o tempo conta como "sem dados"


def _classificar(janela: list[float], cotas: dict) -> str:
    """Faixa de uma leitura. Sensor instável (ou leituras de menos) vira 'incerto', nunca uma classe."""
    if len(janela) < 3 or _pct(janela, .9) - _pct(janela, .1) > ESTAVEL_M:
        return "incerto"
    med = statistics.median(janela)
    classe = "normal"
    for nome, v in cotas.items():
        if v is not None and med >= v:
            classe = nome
    return classe


def zones(days: int) -> dict:
    """Minutos em cada faixa por dia (horário local), com cobertura, para o painel."""
    days = min(max(days, 1), 30)
    now = datetime.now()
    hidro = next((e for e in db.cemaden_estacoes() if e["tipo"] == "hidro"), None)
    out = {"dias": [], "total": {k: 0.0 for k in CATEGORIAS}, "coletado_min": 0.0, "decorrido_min": 0.0,
           "inicio": None, "categorias": list(CATEGORIAS)}
    if not hidro:
        return out
    cotas = {"atencao": hidro["cota_atencao"], "alerta": hidro["cota_alerta"], "transbordamento": hidro["cota_transbordamento"]}
    inicio_dia = (now - timedelta(days=days - 1)).replace(hour=0, minute=0, second=0, microsecond=0)
    rows = db.cemaden_nivel_since(hidro["id"], days * 24 + 2)
    ts = [_t(r["ts"]) for r in rows]
    val = [r["nivel_m"] for r in rows]
    por_dia: dict[str, dict] = {}
    for i in range(len(rows)):
        lo = _janela_lo(ts, i)
        if ts[i] < inicio_dia:
            continue
        nxt = ts[i + 1] if i + 1 < len(rows) else now
        # com leituras de hora em hora o "peso" de cada uma é maior que o padrão
        peso = min(max((nxt - ts[i]).total_seconds() / 60, 0), 65 if (nxt - ts[i]) <= timedelta(minutes=65) else GAP_MAX_MIN)
        dia = por_dia.setdefault(ts[i].date().isoformat(), {k: 0.0 for k in CATEGORIAS})
        dia[_classificar(val[lo:i + 1], cotas)] += peso
    for n in range(days):
        d = (inicio_dia + timedelta(days=n)).date()
        m = por_dia.get(d.isoformat(), {k: 0.0 for k in CATEGORIAS})
        decorrido = 1440.0 if d < now.date() else (now - datetime.combine(d, datetime.min.time())).total_seconds() / 60
        coletado = sum(m.values())
        out["dias"].append({"data": d.isoformat(), **{k: round(m[k], 1) for k in CATEGORIAS},
                            "coletado_min": round(coletado, 1), "decorrido_min": round(decorrido, 1),
                            "cobertura": round(min(1.0, coletado / decorrido), 2) if decorrido else 0.0})
        for k in CATEGORIAS:
            out["total"][k] += m[k]
        out["coletado_min"] += coletado
        out["decorrido_min"] += decorrido
    # chuva por dia (pluviômetro mais próximo com dado): serve para julgar se o nível faz sentido
    ests = db.cemaden_estacoes()
    for e in [x for x in ests if x["tipo"] != "hidro"] + [x for x in ests if x["tipo"] == "hidro"]:
        chuva = db.cemaden_chuva_since(e["id"], days * 24 + 2)
        if chuva and _t(chuva[-1]["ts"]) >= now - timedelta(hours=12):
            soma: dict[str, float] = {}
            for r in chuva:
                soma[r["ts"][:10]] = soma.get(r["ts"][:10], 0.0) + r["mm"]
            for d in out["dias"]:
                d["chuva_mm"] = round(soma.get(d["data"], 0.0), 1)
            out["pluvio"] = _rotulo(e)
            out["chuva_total_mm"] = round(sum(d["chuva_mm"] for d in out["dias"]), 1)
            break
    out["total"] = {k: round(v, 1) for k, v in out["total"].items()}
    out["coletado_min"], out["decorrido_min"] = round(out["coletado_min"], 1), round(out["decorrido_min"], 1)
    out["inicio"] = db.cemaden_nivel_first(hidro["id"])
    return out
