// Monitor do Rio Caratinga: controlador do painel.
// Fluxo: carregar dados → calcular a situação → desenhar só a seção visível.
import { $, $$, h, icon, num, m2, parseTs, fmtDateTime, fmtTime, fmtDate, fmtFull, cap, ago, agoMin, plural, store, toCsv, download } from './util.js';
import { GLOSSARY, GLOSSARY_ORDER } from './glossary.js';
import { assess, zoneOf, rainClass, RAIN_SCALE, STATES } from './situation.js';
import { lineChart, columnChart, sparkline, legend, tableView } from './charts.js';

/* ═════════════════════════ estado ═════════════════════════ */
const S = {
  view: 'overview',
  hours: [6, 24, 72, 168].includes(+store.get('rio-range', '24')) ? +store.get('rio-range', '24') : 24,
  gauge: null,                       // id do pluviômetro escolhido na seção Chuva
  rows: [],                          // leituras da câmera (agregadas) no período
  alerts: [],
  cem: null,                         // resumo do CEMADEN (/api/cemaden)
  cemSeries: null,                   // série do período escolhido
  cem24: null,                       // série de 24 h (visão geral)
  live: null, latest: null,          // leitura ao vivo (SSE) e último registro do banco
  cam: 'wait',                       // 'wait' | 'on' | 'off'
  lastMsg: 0,
  loaded: false, failed: false,
  hidden: {}, tables: {},
  cfg: { alert_level_pct: 70, alert_rise_pct_per_hour: 10, interval_seconds: 300, yolo: true, vision: false, cemaden: false },
  sit: null,
};

const VEH = ['carros', 'motos', 'onibus', 'caminhoes', 'bicicletas'];
const VEH_NAME = { carros: ['carro', 'carros'], motos: ['moto', 'motos'], onibus: ['ônibus', 'ônibus'],
                   caminhoes: ['caminhão', 'caminhões'], bicicletas: ['bicicleta', 'bicicletas'] };
const vehTotal = r => VEH.some(k => r[k] != null) ? VEH.reduce((s, k) => s + (r[k] || 0), 0) : null;
const ZONE_NAMES = { normal: 'Normal', atencao: 'Atenção', alerta: 'Alerta', transbordamento: 'Transbordamento' };
const ZONE_TONE = { normal: 'good', atencao: 'warn', alerta: 'serious', transbordamento: 'crit' };
const RANGE_LABEL = { 6: 'últimas 6 horas', 24: 'últimas 24 horas', 72: 'últimos 3 dias', 168: 'últimos 7 dias' };
const RAIN_TONE = { none: 'good', light: 'info', moderate: 'warn', heavy: 'serious', extreme: 'crit' };
const RAIN_ICON = { none: 'check', light: 'info', moderate: 'alert', heavy: 'alert', extreme: 'alert' };

/* ═════════════════════════ derivados ═════════════════════════ */
const hid = () => (S.cem && S.cem.enabled ? S.cem.hidro : null);
const hidUsable = () => { const x = hid(); return !!(x && x.nivel_m != null && !x.defasado); };
const liveData = () => S.live || S.latest;
/** Pluviômetro mais próximo que tem acumulado de 24 h. */
const gaugeNear = () => (S.cem?.pluvios || []).find(p => p.acc && p.acc['24'] != null) || null;
const gaugeName = p => p.nome.replace(/ \(.*\)/, '');

/** Variação da mediana na última hora, a partir da série de 24 h. */
function trend1h() {
  const ser = (S.cem24 || (S.hours === 24 ? S.cemSeries : null))?.nivel?.filter(r => r.filtrado != null) || [];
  if (ser.length < 2) return null;
  const last = ser[ser.length - 1], tl = parseTs(last.ts);
  const ref = ser.find(r => tl - parseTs(r.ts) <= 3600e3);
  return ref && ref !== last ? { delta1h: +(last.filtrado - ref.filtrado).toFixed(2) } : null;
}

function computeSituation() {
  const d = liveData() || {};
  const g = gaugeNear();
  const ctx = {
    hidro: hid(), trend: trend1h(),
    rain: g ? { nome: gaugeName(g), acc1: g.acc['1'], acc24: g.acc['24'] } : null,
    forecast6h: d.chuva_prox_6h_mm ?? null,
    cam: { state: S.cam, level_pct: d.level_pct, conf: d.level_conf },
    alerts: S.alerts.map(a => ({ ts: parseTs(a.ts) })),
    now: Date.now(),
  };
  S.sit = assess(ctx);
  return S.sit;
}

/* ═════════════════════════ rede ═════════════════════════ */
async function getJSON(u) {
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${u} → ${r.status}`);
  return r.json();
}
const soft = p => p.catch(() => null);
let loading = false;

async function loadAll() {
  if (loading || document.hidden) return;
  loading = true;
  $$('.charts-loading').forEach(el => el.classList.add('is-loading'));
  const cemOn = S.cfg.cemaden;
  const est = S.gauge ? `&est=${S.gauge}` : '';
  try {
    const [rows, alerts, cem, ser, ser24] = await Promise.all([
      getJSON(`/api/readings?hours=${S.hours}&points=360`),
      getJSON('/api/alerts'),
      cemOn ? soft(getJSON('/api/cemaden')) : null,
      cemOn ? soft(getJSON(`/api/cemaden/series?hours=${S.hours}${est}`)) : null,
      // a visão geral sempre mostra 24 h e o pluviômetro padrão, qualquer que seja a escolha em Chuva
      cemOn && (S.hours !== 24 || est) ? soft(getJSON('/api/cemaden/series?hours=24')) : null,
    ]);
    S.rows = rows; S.alerts = alerts; S.cem = cem; S.cemSeries = ser;
    S.cem24 = S.hours === 24 && !est ? ser : ser24;
    if (S.gauge == null && ser?.pluvio_id != null) S.gauge = ser.pluvio_id;
    S.loaded = true; S.failed = false;
  } catch (e) {
    console.warn('painel:', e);
    S.failed = S.rows.length === 0 && !S.cem;
    $('#api-error').hidden = false;
  } finally {
    loading = false;
    $$('.charts-loading').forEach(el => el.classList.remove('is-loading'));
  }
  if (S.loaded) { $('#api-error').hidden = true; renderAll(); }
}

/* ═════════════════════════ vídeo e dados ao vivo ═════════════════════════ */
const camImg = h('img', { id: 'cam', alt: 'Imagem ao vivo da câmera do Rio Caratinga, com a régua de nível e as detecções desenhadas' });
const videoEl = h('figure', { class: 'video is-wait', id: 'video' },
  camImg,
  h('span', { class: 'vchip' }, h('span', { class: 'dot' }), h('span', { id: 'vchip-t' }, 'Conectando')),
  h('button', { class: 'vfs', type: 'button', 'aria-label': 'Tela cheia', title: 'Tela cheia' }, icon('max')),
  h('div', { class: 'vmsg', id: 'vmsg' }, 'Conectando à câmera…'));
let es = null, camRetry = 0, paintTimer = 0;

function setCamState(st) {
  const first = S.cam !== st;
  S.cam = st;
  const on = st === 'on';
  videoEl.classList.toggle('is-off', st === 'off');
  videoEl.classList.toggle('is-wait', st === 'wait');
  $('#vchip-t', videoEl).textContent = on ? 'Ao vivo' : st === 'off' ? 'Sem sinal' : 'Conectando';
  $('#vmsg', videoEl).textContent = st === 'off' ? 'Sem sinal da câmera. Reconectando…' : 'Conectando à câmera…';
  const pill = $('#live-pill');
  pill.dataset.tone = on ? 'good' : st === 'off' ? 'crit' : '';
  pill.querySelector('svg')?.remove();
  pill.querySelector('.dot').hidden = st === 'off';
  if (st === 'off') pill.prepend(icon('xcircle', 'sm'));
  $('#live-text').textContent = on ? 'ao vivo' : st === 'off' ? 'sem sinal' : 'conectando';
  if (first && S.loaded) { renderSituation(); renderKpis(); renderSources(); }
}

function connectLive() {
  if (!es) {
    es = new EventSource('/api/live');
    es.onmessage = e => {
      let d; try { d = JSON.parse(e.data); } catch { return; }
      S.live = d; S.lastMsg = performance.now();
      const was = S.cam;
      setCamState('on');
      if (was !== 'on') renderLiveParts();
      else if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = 0; renderLiveParts(); }, 400);
    };
    es.addEventListener('stale', () => setCamState('off'));
    es.onerror = () => { if (S.cam === 'on') setCamState('off'); };   // o EventSource reconecta sozinho
  }
}
const wantsVideo = () => S.view === 'overview' || S.view === 'camera';
function syncVideo() {
  const slot = S.view === 'overview' ? $('#slot-overview') : S.view === 'camera' ? $('#slot-camera') : null;
  if (slot) {
    if (videoEl.parentElement !== slot) slot.append(videoEl);
    if (!camImg.getAttribute('src') && !document.hidden) camImg.src = '/live.mjpg?t=' + Date.now();
  } else {                         // fora das seções com vídeo, não gasta banda
    videoEl.remove();
    camImg.removeAttribute('src');
  }
}
camImg.addEventListener('load', () => { camRetry = 0; });
camImg.addEventListener('error', () => {   // <img> de MJPEG não reconecta sozinho
  if (document.hidden || !camImg.getAttribute('src')) return;
  setTimeout(() => { if (!document.hidden && wantsVideo()) camImg.src = '/live.mjpg?t=' + Date.now(); }, Math.min(10000, 1500 * ++camRetry));
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { es?.close(); es = null; camImg.removeAttribute('src'); }
  else { connectLive(); syncVideo(); loadAll(); }
});
setInterval(() => {                // vigia: nenhuma leitura há 10 s → sem sinal
  if (es && S.cam === 'on' && performance.now() - S.lastMsg > 10000) setCamState('off');
}, 2000);
$('.vfs', videoEl).addEventListener('click', async () => {
  try {
    if (document.fullscreenElement) await document.exitFullscreen();
    else if (videoEl.requestFullscreen) await videoEl.requestFullscreen();
    else videoEl.classList.toggle('expanded');
  } catch { videoEl.classList.toggle('expanded'); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') videoEl.classList.remove('expanded'); });

/* ═════════════════════════ blocos reutilizáveis ═════════════════════════ */
const badge = (tone, ico, text) => h('span', { class: 'badge', 'data-tone': tone || '' }, ico ? icon(ico, 'sm') : null, h('span', {}, text));
const empty = (ico, title, text, neutral = true) =>
  h('div', { class: 'empty' + (neutral ? ' neutral' : '') }, h('div', { class: 'ring' }, icon(ico)), h('div', {}, h('b', {}, title), h('p', {}, text)));
const termBtn = (id, label) => h('button', { class: 'term', type: 'button', 'data-term': id, 'aria-label': label || `O que é ${GLOSSARY[id].title.toLowerCase()}?` }, '?');

/** Régua das cotas: faixas coloridas, marcador do nível e valores das cotas. */
function zonesBar(cotas, nivel, { big = false, unsure = false } = {}) {
  const a = cotas.atencao, b = cotas.alerta, c = cotas.transbordamento;
  if (a == null || b == null || c == null) return h('div');
  const max = Math.max(c * 1.25, (nivel ?? 0) * 1.08, 1);
  const pct = v => Math.max(0, Math.min(100, v / max * 100));
  const zone = nivel == null ? null : zoneOf(nivel, cotas);
  const seg = (z, from, to) => h('i', { 'data-zone': z, class: !unsure && zone === z ? 'on' : '', style: `flex:${to - from}`, title: `${ZONE_NAMES[z]}: ${from === 0 ? 'abaixo de ' + m2(to) : z === 'transbordamento' ? 'a partir de ' + m2(from) : m2(from) + ' a ' + m2(to)} m` },
    big ? h('span', { class: 'zn' }, ZONE_NAMES[z]) : null);
  const lbl = [h('span', { style: 'left:0' }, '0')];
  for (const [k, v] of [['atencao', a], ['alerta', b], ['transbordamento', c]]) {
    lbl.push(h('span', { style: `left:${pct(v)}%` }, m2(v)));
  }
  return h('div', { class: 'zones' + (big ? ' big' : '') + (unsure ? ' unsure' : '') },
    h('div', { class: 'zones-bar' }, seg('normal', 0, a), seg('atencao', a, b), seg('alerta', b, c), seg('transbordamento', c, max)),
    nivel != null ? h('div', { class: 'zones-pin', style: `left:${pct(nivel)}%`, role: 'img', 'aria-label': `Nível atual ${m2(nivel)} m` }) : null,
    h('div', { class: 'zones-lbl' }, ...lbl));
}

function trendNode(delta) {
  if (delta == null) return null;
  const up = delta > 0.04, down = delta < -0.04;
  return h('span', { class: 'chip' }, icon(up ? 'up' : down ? 'down' : 'minus', 'sm'),
    up || down ? `${up ? '+' : '−'}${m2(Math.abs(delta))} m em 1 h` : 'estável em 1 h');
}

/* ═════════════════════════ cabeçalho ═════════════════════════ */
function renderChrome() {
  const x = hid(), el = $('#fresh');
  let text = 'Sem dados do CEMADEN';
  if (x?.ultimo) text = `Nível medido ${agoMin(x.idade_min)}`;
  else if (S.cem?.atualizado) text = 'CEMADEN conectado';
  el.querySelector('span').textContent = text;
  el.title = x?.ultimo ? `Última medição da estação: ${fmtFull.format(parseTs(x.ultimo.ts))}` : '';
}

/* ═════════════════════════ visão geral ═════════════════════════ */
function renderSituation() {
  const s = computeSituation();
  const el = $('#sit');
  el.dataset.tone = s.tone;
  $('#sit-ico').setAttribute('href', '#i-' + s.icon);
  $('#sit-title').textContent = s.headline;
  $('#sit-sum').textContent = s.summary;
  const x = hid();
  $('#sit-age').textContent = x?.ultimo ? `· dados do CEMADEN ${agoMin(x.idade_min)}` : '';
  const ul = $('#sit-why');
  ul.replaceChildren(...s.reasons.map(r => h('li', { 'data-kind': r.kind },
    icon(r.kind === 'ok' ? 'check' : r.kind === 'warn' ? 'alert' : 'info', 'sm'), h('span', {}, r.text))));
}

function renderKpis() {
  const d = liveData() || {}, x = hid();
  // nível
  const lvl = $('#k-level-val'), zb = $('#k-level-zones');
  zb.replaceChildren();
  $('#k-level-badge').replaceChildren();
  $('#k-level-foot').replaceChildren();
  if (x && x.nivel_m != null) {
    lvl.replaceChildren(m2(x.nivel_m), h('small', {}, 'm'));
    lvl.classList.toggle('dim', !x.estavel || x.defasado);
    const st = !x.estavel ? { tone: '', ico: 'info', label: 'Sensor instável' }
      : { tone: ZONE_TONE[x.classe], ico: x.classe === 'normal' ? 'check' : 'alert', label: ZONE_NAMES[x.classe] };
    $('#k-level-badge').append(badge(st.tone, st.ico, st.label));
    $('#k-level-sub').textContent = `Mediana da última hora · estação ${x.nome}`;
    zb.append(zonesBar(x.cotas, x.nivel_m, { unsure: !x.estavel }));
    const t = trendNode(x.estavel ? trend1h()?.delta1h : null);
    $('#k-level-foot').append(...[t, h('span', {}, `Medido ${agoMin(x.idade_min)}`)].filter(Boolean));
  } else {
    lvl.replaceChildren('—'); lvl.classList.add('dim');
    $('#k-level-badge').append(badge('', 'info', 'Sem leitura'));
    $('#k-level-sub').textContent = 'A estação do CEMADEN não enviou leitura recente.';
  }
  // chuva
  const g = gaugeNear();
  const rv = $('#k-rain-val');
  if (g) {
    const rc = rainClass(g.acc['24']);
    rv.replaceChildren(num(g.acc['24'], 1), h('small', {}, 'mm'));
    $('#k-rain-badge').replaceChildren(badge(RAIN_TONE[rc.id], RAIN_ICON[rc.id], rc.label));
    $('#k-rain-sub').textContent = `${gaugeName(g)} · última hora: ${num(g.acc['1'], 1)} mm`;
  } else {
    rv.replaceChildren('—'); $('#k-rain-badge').replaceChildren(badge('', 'info', 'Sem dado')); $('#k-rain-sub').textContent = 'Pluviômetros sem leitura recente.';
  }
  // previsão
  const fc = d.chuva_prox_6h_mm;
  $('#k-fc-val').replaceChildren(num(fc, 1), ...(fc != null ? [h('small', {}, 'mm')] : []));
  $('#k-fc-sub').textContent = d.condicao ? `${cap(d.condicao)}${d.temp_c != null ? ` · ${num(d.temp_c, 0)} °C` : ''}` : 'Sem dado de previsão.';
  // câmera
  const on = S.cam === 'on';
  $('#k-cam-badge').replaceChildren(on ? badge('good', 'check', 'Ao vivo') : S.cam === 'off' ? badge('crit', 'xcircle', 'Sem sinal') : badge('', 'info', 'Conectando'));
  const ppl = d.pessoas, veh = vehTotal(d);
  $('#k-cam-sub').textContent = on && S.cfg.yolo ? `${num(ppl, 0)} ${plural(ppl, 'pessoa', 'pessoas')} · ${num(veh, 0)} ${plural(veh, 'veículo', 'veículos')} na cena`
    : on ? 'Imagem ao vivo.' : d.ts ? `Última imagem registrada ${agoMin((Date.now() - parseTs(d.ts)) / 60000)}.` : 'Sem imagem recente.';
  const conf = d.level_conf;
  $('#k-cam-foot').textContent = d.level_pct != null
    ? `Nível pela câmera: ${num(d.level_pct, 0)}% da régua · confiança ${num((conf ?? 0) * 100, 0)}%${(conf ?? 0) < 0.5 ? ' (não usado)' : ''}`
    : 'Nível pela câmera: sem leitura';
}

function eventsNode(limit = 4) {
  if (!S.alerts.length) {
    const lvl = S.cfg.alert_level_pct, rise = S.cfg.alert_rise_pct_per_hour;
    return empty('check', 'Nenhum alerta registrado', `O painel registra um alerta quando a câmera estima o nível acima de ${num(lvl, 0)}% da régua ou subindo mais de ${num(rise, 0)} pontos por hora.`, false);
  }
  const kinds = { nivel_alto: ['crit', 'Nível alto pela câmera', 'alert'], subida_rapida: ['warn', 'Subida rápida pela câmera', 'up'] };
  return h('div', { class: 'events' }, ...S.alerts.slice(0, limit).map(a => {
    const [tone, label, ico] = kinds[a.kind] || ['warn', String(a.kind).replace(/_/g, ' '), 'bell'];
    const t = parseTs(a.ts);
    return h('div', { class: 'event', 'data-tone': tone }, h('div', { class: 'b' }, icon(ico)), h('b', { class: 't' }, label),
      h('p', {}, a.message || ''), h('time', { datetime: a.ts, title: fmtFull.format(t) }, `${ago(t)} · ${fmtDateTime.format(t)}`));
  }));
}

/** Estado de cada fonte, para a faixa de confiança e para a seção de dados. */
function sources() {
  const x = hid(), d = liveData() || {}, ps = S.cem?.pluvios || [];
  const lastRain = ps.map(p => p.ultimo).filter(Boolean).sort().pop();
  const rainAge = lastRain ? Math.round((Date.now() - parseTs(lastRain)) / 60000) : null;
  const ok = (tone = 'good') => ({ tone, ico: 'check' });
  return [
    { id: 'nivel', ico: 'waves', name: 'Nível do rio', by: 'CEMADEN · estação hidrológica',
      ...(!x || x.nivel_m == null || x.defasado ? { tone: 'crit', ico2: 'xcircle', label: 'Sem leitura' }
        : !x.estavel ? { tone: 'warn', ico2: 'alert', label: 'Sensor instável' } : { tone: 'good', ico2: 'check', label: 'Estável' }),
      age: x?.ultimo ? agoMin(x.idade_min) : '—',
      what: 'Altura da água, em metros, medida por sensor na própria estação do rio, com as cotas oficiais.',
      freq: 'Leitura a cada 10 a 30 minutos.',
      limit: 'O sensor registra saltos de até ~1 m sem chuva. O painel usa a mediana de 1 hora e avisa quando está instável.' },
    { id: 'chuva', ico: 'rain', name: 'Chuva medida', by: 'CEMADEN · pluviômetros',
      ...(rainAge == null ? { tone: 'crit', ico2: 'xcircle', label: 'Sem leitura' } : rainAge > 120 ? { tone: 'warn', ico2: 'alert', label: 'Atrasada' } : { tone: 'good', ico2: 'check', label: 'Em dia' }),
      age: rainAge == null ? '—' : agoMin(rainAge),
      what: 'Milímetros de chuva por hora e acumulados, medidos nas estações oficiais mais próximas da câmera.',
      freq: 'Atualizada de hora em hora, com pequenos atrasos.',
      limit: 'Cada pluviômetro mede um ponto. A chuva pode ser diferente a poucos quilômetros.' },
    { id: 'camera', ico: 'camera', name: 'Câmera', by: 'CDL Caratinga · análise automática',
      ...(S.cam === 'on' ? { tone: 'good', ico2: 'check', label: 'Ao vivo' } : S.cam === 'off' ? { tone: 'crit', ico2: 'xcircle', label: 'Sem sinal' } : { tone: '', ico2: 'info', label: 'Conectando' }),
      age: S.cam === 'on' ? 'agora' : d.ts ? ago(parseTs(d.ts)) : '—',
      what: 'Vídeo do rio com estimativa do nível pela cor da água, contagem de pessoas e veículos.',
      freq: 'Quadros ao vivo; histórico gravado a cada ' + (S.cfg.interval_seconds >= 60 ? Math.round(S.cfg.interval_seconds / 60) + ' min' : S.cfg.interval_seconds + ' s') + '.',
      limit: 'Precisa de luz do dia e de calibração da régua. Reflexos e chuva na lente reduzem a confiança.' },
    { id: 'prev', ico: 'cloud', name: 'Previsão', by: 'Open-Meteo · modelo',
      ...(d.chuva_prox_6h_mm != null ? { tone: 'good', ico2: 'check', label: 'Disponível' } : { tone: '', ico2: 'info', label: 'Sem dado' }),
      age: '', what: 'Chuva prevista para as próximas 6 horas, temperatura e condição do tempo.',
      freq: 'Atualizado a cada alguns minutos.',
      limit: 'É uma estimativa para a região. Não é medição e pode errar o local e o horário da chuva.' },
  ];
}

function renderSources() {
  const list = sources();
  $('#ov-srcs').replaceChildren(...list.map(s => h('div', { class: 'src' },
    h('div', { class: 'src-h' }, icon(s.ico), s.name),
    badge(s.tone, s.ico2, s.label),
    h('small', {}, s.age ? `${s.by} · ${s.age}` : s.by))));
}

function renderOverviewCharts() {
  const cs = S.cem24;
  const nivel = (cs?.nivel || []).map(r => ({ t: parseTs(r.ts), nivel_m: r.nivel_m, filtrado: r.filtrado }));
  const chuva = (cs?.chuva || []).map(r => ({ t: parseTs(r.ts), mm: r.mm }));
  const t1 = Math.max(nivel.length ? nivel[nivel.length - 1].t : 0, chuva.length ? chuva[chuva.length - 1].t : 0, Date.now() - 60e3);
  const t0 = t1 - 24 * 3600e3;
  const lv = $('#ov-lv'), rn = $('#ov-rn');
  if (!S.cfg.cemaden || !nivel.length) {
    lv.replaceChildren(h('div', { class: 'chart-empty' }, h('span', {}, 'Aguardando dados do CEMADEN…')));
    rn.replaceChildren();
    return;
  }
  const c = cs.hidro?.cotas || {};
  const common = { t0, t1, mr: 60, sync: 'ov', xFmt: t => fmtTime.format(t), tipTitle: t => fmtDateTime.format(t) };
  lineChart(lv, { ...common, rows: nivel, aria: 'Nível do rio nas últimas 24 horas, mediana de 1 hora', yFmt: v => num(v, 1), valFmt: v => m2(v) + ' m',
    series: [{ key: 'filtrado', label: 'Nível (mediana 1 h)', color: '--s1' }], endLabel: true,
    bands: zoneBands(c).map(b => ({ ...b, label: null })), thresholds: zoneLines(c) });
  const wet = chuva.some(r => r.mm > 0);
  rn.classList.toggle('flat', !wet);
  if (!wet) {   // sem chuva: uma linha basta, não um gráfico vazio
    rn.replaceChildren(h('div', { class: 'flat-msg' }, icon('check', 'sm'), 'Sem chuva medida nas últimas 24 horas'));
    return;
  }
  columnChart(rn, { ...common, rows: chuva, key: 'mm', agg: 'sum', n: 24, color: '--s1', label: 'Chuva', valFmt: v => num(v, 1) + ' mm',
    aria: 'Chuva por hora nas últimas 24 horas' });
}

/** Fundo colorido por faixa de cota (para o gráfico). */
function zoneBands(c) {
  if (c.atencao == null) return [];
  return [
    { from: 0, to: c.atencao, color: '--good', opacity: 0.05, label: 'Normal' },
    { from: c.atencao, to: c.alerta, color: '--warn', opacity: 0.12, label: 'Atenção' },
    { from: c.alerta, to: c.transbordamento, color: '--serious', opacity: 0.13, label: 'Alerta' },
    { from: c.transbordamento, to: null, color: '--crit', opacity: 0.13, label: 'Transbordamento' },
  ];
}
const zoneLines = c => ['atencao', 'alerta', 'transbordamento'].filter(k => c[k] != null).map(k => ({ v: c[k], label: `${m2(c[k])} m` }));

/* ═════════════════════════ seção Rio ═════════════════════════ */
function nivelRows() {
  return (S.cemSeries?.nivel || []).map(r => ({ t: parseTs(r.ts), nivel_m: r.nivel_m, filtrado: r.filtrado }));
}

function renderRio() {
  const cs = S.cemSeries, x = hid();
  const rows = nivelRows();
  const t1 = Math.max(rows.length ? rows[rows.length - 1].t : 0, Date.now() - 60e3), t0 = t1 - S.hours * 3600e3;
  const vals = rows.map(r => r.filtrado).filter(v => v != null);

  // estatísticas do período
  const st = (id, v, unit = 'm') => { const el = $(id); el.replaceChildren(v == null ? '—' : m2(v), ...(v == null ? [] : [h('small', {}, unit)])); };
  st('#rs-now', x?.nivel_m);
  st('#rs-min', vals.length ? Math.min(...vals) : null);
  st('#rs-max', vals.length ? Math.max(...vals) : null);
  const dl = vals.length > 1 ? vals[vals.length - 1] - vals[0] : null;
  $('#rs-delta').replaceChildren(dl == null ? '—' : `${dl > 0 ? '+' : dl < 0 ? '−' : ''}${m2(Math.abs(dl))}`, ...(dl == null ? [] : [h('small', {}, 'm')]));

  // gráfico
  const c = cs?.hidro?.cotas || {};
  const sub = $('#c-rio-sub');
  sub.replaceChildren(`${cap(RANGE_LABEL[S.hours])} · ${cs?.hidro?.nome || 'estação'} · linha escura: mediana de 1 h; linha clara: leituras brutas`);
  const host = $('#c-rio'), tbl = $('#t-rio');
  host.hidden = !!S.tables.rio; tbl.hidden = !S.tables.rio;
  const cols = [{ h: 'Data e hora', f: r => fmtDateTime.format(r.t) }, { h: 'Leitura bruta (m)', f: r => m2(r.nivel_m) }, { h: 'Mediana de 1 h (m)', f: r => m2(r.filtrado) }];
  if (!rows.length) host.replaceChildren(h('div', { class: 'chart-empty' }, h('span', {}, S.cfg.cemaden ? 'Sem dados do CEMADEN neste período.' : 'O CEMADEN está desativado (CEMADEN_ENABLED=false).')));
  else if (S.tables.rio) tableView(tbl, cols, rows);
  else {
    lineChart(host, { rows, t0, t1, hidden: S.hidden, xFmt: xf(t1), tipTitle: t => fmtDateTime.format(t), aria: `Nível do rio na estação do CEMADEN, ${RANGE_LABEL[S.hours]}.`,
      yFmt: v => num(v, 1), valFmt: v => m2(v) + ' m', endLabel: true, bands: zoneBands(c), thresholds: zoneLines(c),
      series: [{ key: 'nivel_m', label: 'Leitura bruta', color: '--s1', faint: true }, { key: 'filtrado', label: 'Mediana de 1 h', color: '--s1' }] });
  }
  legend($('#lg-rio'), [{ key: 'nivel_m', label: 'Leitura bruta', color: '--s1', faint: true }, { key: 'filtrado', label: 'Mediana de 1 h', color: '--s1' }], S.hidden, renderRio);
  $('#lg-rio').hidden = !!S.tables.rio;

  // aviso de estabilidade
  const note = $('#rio-note');
  note.hidden = !(x && x.nivel_m != null && !x.estavel);
  if (!note.hidden) $('#rio-note-t').textContent = `O sensor oscilou ${m2(x.variacao_m)} m na última hora. Leia o gráfico pela linha escura (mediana) e use a chuva medida e a câmera para conferir. Enquanto oscilar mais de 0,5 m, a classificação por cotas fica suspensa.`;

  // faixas
  const zonesHost = $('#rio-zones'), defs = $('#rio-defs');
  zonesHost.replaceChildren(); defs.replaceChildren();
  if (x?.cotas && x.cotas.atencao != null) {
    zonesHost.append(zonesBar(x.cotas, x.nivel_m, { big: true, unsure: !x.estavel }));
    const k = x.cotas;
    const D = [
      ['normal', 'Normal', `abaixo de ${m2(k.atencao)} m`, 'Nível dentro do esperado para o rio.'],
      ['atencao', 'Atenção', `${m2(k.atencao)} a ${m2(k.alerta)} m`, 'O nível começa a exigir acompanhamento.'],
      ['alerta', 'Alerta', `${m2(k.alerta)} a ${m2(k.transbordamento)} m`, 'Aumenta o risco de a água atingir áreas mais baixas perto do rio.'],
      ['transbordamento', 'Transbordamento', `a partir de ${m2(k.transbordamento)} m`, 'A água atinge a altura em que sai da calha do rio.'],
    ];
    defs.append(...D.map(([z, name, rng, txt]) => h('div', { class: 'def', 'data-zone': z }, h('b', {}, name), h('span', { class: 'rng' }, rng), h('p', {}, txt))));
  } else zonesHost.append(empty('info', 'Cotas indisponíveis', 'A estação ainda não enviou as cotas de referência.'));

  // comparação entre fontes
  const d = liveData() || {};
  const cmp = $('#cmp');
  const conf = d.level_conf;
  cmp.replaceChildren(
    h('div', {}, h('span', { class: 'eyebrow' }, 'Estação do CEMADEN (oficial)'),
      h('b', {}, x?.nivel_m != null ? `${m2(x.nivel_m)} m` : '—'),
      h('p', { class: 'fine' }, x?.nivel_m == null ? 'Sem leitura recente.' : x.estavel ? `Faixa: ${ZONE_NAMES[x.classe]} · medido ${agoMin(x.idade_min)}` : `Sensor instável (variou ${m2(x.variacao_m)} m na última hora)`)),
    h('div', {}, h('span', { class: 'eyebrow' }, 'Câmera (estimativa)'),
      h('b', {}, d.level_pct != null ? `${num(d.level_pct, 0)}% da régua` : '—'),
      h('p', { class: 'fine' }, d.level_pct == null ? 'Sem leitura (sem luz ou sem imagem).' : `Confiança ${num((conf ?? 0) * 100, 0)}%${(conf ?? 0) < 0.5 ? ': baixa, não entra na decisão' : ''}`)));
  cmp.append(h('p', { class: 'fine', style: 'grid-column:1/-1' }, 'As duas fontes usam escalas diferentes (metros na estação, % de uma régua desenhada na imagem). Use a câmera para conferir a tendência, não para comparar valores.'));
}
const xf = t1 => t => (S.hours <= 36 && new Date(t).toDateString() === new Date(t1).toDateString()) ? fmtTime.format(t) : `${fmtDate.format(t)} ${fmtTime.format(t)}`;

/* ═════════════════════════ seção Chuva ═════════════════════════ */
function renderChuva() {
  const cs = S.cemSeries;
  const rows = (cs?.chuva || []).map(r => ({ t: parseTs(r.ts), mm: r.mm }));
  const t1 = Math.max(rows.length ? rows[rows.length - 1].t : 0, Date.now() - 60e3), t0 = t1 - S.hours * 3600e3;
  const inRange = rows.filter(r => r.t >= t0);

  // seletor de pluviômetro
  const sel = $('#gauge');
  const opts = cs?.pluvios || [];
  if (sel.options.length !== opts.length) {
    sel.replaceChildren(...opts.map(p => h('option', { value: p.id }, `${p.nome} · ${num(p.dist_km, 1)} km`)));
  }
  if (S.gauge != null) sel.value = String(S.gauge);

  // estatísticas
  const total = inRange.reduce((s, r) => s + r.mm, 0), peak = inRange.reduce((m, r) => Math.max(m, r.mm), 0);
  const wet = inRange.filter(r => r.mm > 0).length;
  const mmEl = (id, v) => { const el = $(id); el.replaceChildren(num(v, 1), h('small', {}, 'mm')); };
  if (inRange.length) { mmEl('#ch-total', total); mmEl('#ch-peak', peak); $('#ch-hours').replaceChildren(String(wet), h('small', {}, `de ${inRange.length} h`)); }
  else for (const id of ['#ch-total', '#ch-peak', '#ch-hours']) $(id).replaceChildren('—');
  const cur = (S.cem?.pluvios || []).find(p => String(p.id) === String(S.gauge));
  const a24 = cur?.acc?.['24'];
  $('#ch-24').replaceChildren(num(a24, 1), ...(a24 != null ? [h('small', {}, 'mm · ' + rainClass(a24).label.toLowerCase())] : []));

  // gráfico
  $('#c-chuva-h').textContent = `Chuva por hora · ${cs?.pluvio ? cs.pluvio.replace(/ \(.*\)/, '') : 'pluviômetro'}`;
  $('#c-chuva-sub').textContent = `${cap(RANGE_LABEL[S.hours])} · milímetros acumulados em cada hora cheia`;
  const host = $('#c-chuva'), tbl = $('#t-chuva');
  host.hidden = !!S.tables.chuva; tbl.hidden = !S.tables.chuva;
  if (!rows.length) host.replaceChildren(h('div', { class: 'chart-empty' }, h('span', {}, 'Sem dados de chuva neste período.')));
  else if (S.tables.chuva) tableView(tbl, [{ h: 'Hora', f: r => fmtDateTime.format(r.t) }, { h: 'Chuva (mm)', f: r => num(r.mm, 1) }], rows);
  else columnChart(host, { rows, t0, t1, key: 'mm', agg: 'sum', n: S.hours, color: '--s1', label: 'Chuva', xFmt: xf(t1),
    tipTitle: t => fmtDateTime.format(t), valFmt: v => num(v, 1) + ' mm', aria: `Chuva por hora, ${RANGE_LABEL[S.hours]}.`,
    zeroMsg: 'Sem chuva medida neste período' });

  // tabela por pluviômetro
  const body = $('#rg-body');
  body.replaceChildren(...(S.cem?.pluvios || []).map(p => h('tr', {},
    h('td', {}, p.nome, h('small', {}, `a ${num(p.dist_km, 1)} km da câmera`)),
    ...['1', '6', '24', '72'].map(k => h('td', {}, p.acc[k] == null ? '—' : num(p.acc[k], 1))))));
  const ult = (S.cem?.pluvios || []).map(p => p.ultimo).filter(Boolean).sort().pop();
  $('#rg-age').textContent = ult ? `Milímetros acumulados. Dados até ${fmtTime.format(parseTs(ult))}.` : 'Sem dados recentes.';

  // previsão + escala
  const d = liveData() || {};
  $('#fc-box').replaceChildren(
    h('div', {}, h('span', { class: 'eyebrow' }, 'Previsão · próximas 6 h'), h('b', {}, d.chuva_prox_6h_mm != null ? `${num(d.chuva_prox_6h_mm, 1)} mm` : '—'),
      h('p', { class: 'fine' }, d.condicao ? cap(d.condicao) : 'Sem dado')),
    h('div', {}, h('span', { class: 'eyebrow' }, 'Agora (modelo)'), h('b', {}, d.chuva_agora_mm != null ? `${num(d.chuva_agora_mm, 1)} mm` : '—'),
      h('p', { class: 'fine' }, d.temp_c != null ? `${num(d.temp_c, 0)} °C` : 'Sem dado')));
  const cls = a24 != null ? rainClass(a24).id : null;
  $('#scale-body').replaceChildren(...RAIN_SCALE.map(c => h('tr', { style: cls === c.id ? 'background:var(--sunken)' : '' },
    h('td', {}, c.range), h('td', { style: 'text-align:left;white-space:normal' }, c.label + (cls === c.id ? ' ← agora' : '')))));
}

/* ═════════════════════════ seção Câmera ═════════════════════════ */
function renderCameraLive() {
  if (S.view !== 'camera') return;
  const d = liveData() || {};
  const on = S.cam === 'on';
  $('#cm-age').textContent = on ? 'Dados em tempo real' : d.ts ? `Última leitura ${ago(parseTs(d.ts))}` : 'Sem leitura';
  const ppl = d.pessoas, veh = vehTotal(d);
  const parts = VEH.filter(k => d[k]).map(k => `${d[k]} ${VEH_NAME[k][d[k] === 1 ? 0 : 1]}`);
  const cell = (label, val, sub, term) => h('div', {}, h('span', { class: 'eyebrow' }, label, term ? termBtn(term) : null), h('b', {}, val), h('p', { class: 'fine' }, sub));
  $('#cm-now').replaceChildren(
    cell('Pessoas', S.cfg.yolo ? num(ppl, 0) : '—', S.cfg.yolo ? 'na cena' : 'contagem desativada'),
    cell('Veículos', S.cfg.yolo ? num(veh, 0) : '—', S.cfg.yolo ? (parts.join(' · ') || 'nenhum agora') : 'contagem desativada'),
    cell('Movimento', d.movimento_pct != null ? `${num(d.movimento_pct, 1)}%` : '—', 'da imagem mudou', 'movimento'),
    cell('Cena', d.periodo ? cap(d.periodo) : '—', d.visibilidade ? `visibilidade ${String(d.visibilidade).replace(/\s*\(.*\)/, '')}` : ''));
}

function renderCamera() {
  renderCameraLive();
  const rows = S.rows.map(r => ({ ...r, t: parseTs(r.ts), veh: vehTotal(r) }));
  const t1 = Math.max(rows.length ? rows[rows.length - 1].t : 0, Date.now() - 60e3), t0 = t1 - S.hours * 3600e3;
  const none = rows.length === 0;
  const msg = (text) => h('div', { class: 'chart-empty' }, h('span', {}, text));
  const common = { rows, t0, t1, xFmt: xf(t1), tipTitle: t => fmtDateTime.format(t), hidden: S.hidden };

  // pessoas e veículos
  $('#c-count-sub').textContent = `${cap(RANGE_LABEL[S.hours])} · maior contagem em cada intervalo`;
  const ch = $('#c-count'), ct = $('#t-count');
  ch.hidden = !!S.tables.count; ct.hidden = !S.tables.count;
  const cser = [{ key: 'pessoas', label: 'Pessoas', color: '--s1' }, { key: 'veh', label: 'Veículos', color: '--s2' }];
  legend($('#lg-count'), cser, S.hidden, renderCamera);
  $('#lg-count').hidden = !!S.tables.count || !S.cfg.yolo;
  if (none || !S.cfg.yolo) ch.replaceChildren(msg(S.cfg.yolo ? 'Ainda sem leituras neste período.' : 'A contagem está desativada (ENABLE_YOLO=false).'));
  else if (S.tables.count) tableView(ct, [{ h: 'Data e hora', f: r => fmtDateTime.format(r.t) }, { h: 'Pessoas', f: r => num(r.pessoas, 0) }, { h: 'Veículos', f: r => num(r.veh, 0) }], rows);
  else lineChart(ch, { ...common, int: true, yFmt: v => num(v, 0), valFmt: v => num(v, 0), endLabel: true, aria: `Pessoas e veículos, ${RANGE_LABEL[S.hours]}.`, series: cser });

  // nível pela câmera
  const lv = rows.filter(r => r.level_pct != null);
  const avg = lv.length ? lv.reduce((s, r) => s + (r.level_conf ?? 0), 0) / lv.length : null;
  $('#c-cam-sub').textContent = `${cap(RANGE_LABEL[S.hours])} · % da régua${avg != null ? ` · confiança média ${num(avg * 100, 0)}%` : ''}`;
  const cc = $('#c-cam'), cct = $('#t-cam');
  cc.hidden = !!S.tables.cam; cct.hidden = !S.tables.cam;
  if (none) cc.replaceChildren(msg('Ainda sem leituras neste período.'));
  else if (S.tables.cam) tableView(cct, [{ h: 'Data e hora', f: r => fmtDateTime.format(r.t) }, { h: 'Nível (%)', f: r => num(r.level_pct, 1) },
    { h: 'Confiança', f: r => r.level_conf == null ? '—' : Math.round(r.level_conf * 100) + '%' }], rows);
  else lineChart(cc, { ...common, yMax: 100, yStep: 25, yFmt: v => v + '%', valFmt: v => num(v, 1) + '%', endLabel: true, area: true,
    aria: `Nível estimado pela câmera, ${RANGE_LABEL[S.hours]}.`, series: [{ key: 'level_pct', label: 'Nível (câmera)', color: '--s1' }],
    thresholds: [{ v: S.cfg.alert_level_pct, label: `Limite de alerta ${num(S.cfg.alert_level_pct, 0)}%`, below: true }] });
}

/* ═════════════════════════ seção Dados e ajuda ═════════════════════════ */
function renderDados() {
  $('#dd-srcs').replaceChildren(...sources().map(s => h('div', { class: 'src' },
    h('div', { class: 'src-h' }, icon(s.ico), s.name),
    badge(s.tone, s.ico2, s.label),
    h('small', {}, s.age ? `${s.by} · ${s.age}` : s.by),
    h('p', { class: 'fine' }, s.what), h('p', { class: 'fine' }, h('b', {}, 'Frequência: '), s.freq), h('p', { class: 'fine' }, h('b', {}, 'Limitação: '), s.limit))));
  $('#dl-note').textContent = `Período dos arquivos: ${RANGE_LABEL[S.hours]} (altere em Rio, Chuva ou Câmera).`;
  const host = $('#glossary');
  if (!host.childElementCount) {
    host.append(...GLOSSARY_ORDER.map(id => {
      const g = GLOSSARY[id];
      return h('details', { id: 'g-' + id }, h('summary', {}, h('span', {}, g.title)), h('div', { class: 'body' }, ...g.body.map(t => h('p', {}, t))));
    }));
  }
}

/* ═════════════════════════ ajuda contextual ═════════════════════════ */
const dlg = $('#help');
function openTerm(id) {
  const g = GLOSSARY[id];
  if (!g) return;
  $('#help-t').textContent = g.title;
  $('#help-b').replaceChildren(...g.body.map(t => h('p', {}, t)));
  $('#help-more').onclick = () => { dlg.close(); setTimeout(() => $('#g-' + id)?.setAttribute('open', ''), 60); };
  if (!dlg.open) dlg.showModal();
}
document.addEventListener('click', e => {
  const t = e.target.closest('[data-term]');
  if (t) { openTerm(t.dataset.term); return; }
  const tb = e.target.closest('.tbl-btn');
  if (tb) {
    const id = tb.closest('[data-chart]').dataset.chart;
    S.tables[id] = !S.tables[id];
    tb.querySelector('use').setAttribute('href', S.tables[id] ? '#i-chart' : '#i-table');
    tb.setAttribute('aria-label', S.tables[id] ? 'Ver como gráfico' : 'Ver como tabela');
    tb.title = tb.getAttribute('aria-label');
    renderView(S.view);
    return;
  }
  const dl = e.target.closest('[data-dl]');
  if (dl) downloadData(dl.dataset.dl);
});
$('#help-btn').addEventListener('click', () => { dlg.showModal(); openTerm('status'); });
$('#help-x').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });   // clicar no fundo fecha

function downloadData(kind) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (m) => (m === 'T' ? '_' : ''));
  const span = `${S.hours}h`;
  if (kind === 'nivel') {
    const rows = S.cemSeries?.nivel || [];
    if (!rows.length) return alert('Sem dados de nível para baixar neste período.');
    download(`rio-caratinga_nivel-cemaden_${span}_${stamp}.csv`, toCsv([
      { h: 'data_hora_local', v: r => r.ts }, { h: 'nivel_bruto_m', v: r => r.nivel_m }, { h: 'mediana_1h_m', v: r => r.filtrado }], rows));
  } else if (kind === 'chuva') {
    const rows = S.cemSeries?.chuva || [];
    if (!rows.length) return alert('Sem dados de chuva para baixar neste período.');
    const nome = S.cemSeries.pluvio || '';
    download(`rio-caratinga_chuva-cemaden_${span}_${stamp}.csv`, toCsv([
      { h: 'hora_local', v: r => r.ts }, { h: 'chuva_mm', v: r => r.mm }, { h: 'pluviometro', v: () => nome }], rows));
  } else {
    const rows = S.rows;
    if (!rows.length) return alert('Sem leituras da câmera para baixar neste período.');
    download(`rio-caratinga_camera_${span}_${stamp}.csv`, toCsv([
      { h: 'data_hora_local', v: r => r.ts }, { h: 'nivel_camera_pct', v: r => r.level_pct }, { h: 'confianca_0a1', v: r => r.level_conf },
      { h: 'pessoas', v: r => r.pessoas }, { h: 'veiculos', v: r => vehTotal(r) }, { h: 'movimento_pct', v: r => r.movimento_pct },
      { h: 'chuva_prevista_6h_mm', v: r => r.chuva_prox_6h_mm }], rows));
  }
}

/* ═════════════════════════ roteamento ═════════════════════════ */
const ROUTES = { 'visao-geral': 'overview', rio: 'rio', chuva: 'chuva', camera: 'camera', dados: 'dados' };
const HASH = Object.fromEntries(Object.entries(ROUTES).map(([k, v]) => [v, k]));
const RENDER = { overview: renderOverview, rio: renderRio, chuva: renderChuva, camera: renderCamera, dados: renderDados };

function renderOverview() {
  renderSituation(); renderKpis(); renderSources(); renderOverviewCharts();
  $('#ov-events').replaceChildren(eventsNode(4));
}
function renderView(id) { if (S.loaded || id === 'dados') RENDER[id]?.(); }
function renderAll() { renderChrome(); renderView(S.view); renderSituationIfHidden(); }
function renderSituationIfHidden() { if (S.view !== 'overview') computeSituation(); }
function renderLiveParts() {
  renderKpisIfVisible();
  renderCameraLive();
}
function renderKpisIfVisible() { if (S.view === 'overview') { renderKpis(); renderSituation(); } }

function route() {
  const key = (location.hash.replace(/^#\/?/, '') || 'visao-geral').split('?')[0];
  const id = ROUTES[key] || 'overview';
  S.view = id;
  $$('.view').forEach(v => { v.hidden = v.id !== 'v-' + id; });
  $$('.nav a').forEach(a => {
    if (a.dataset.view === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  const sec = $('#v-' + id);
  document.title = `${sec.dataset.title} · Rio Caratinga`;
  $('#bar-title').textContent = sec.dataset.title;
  syncVideo();
  renderView(id);
  window.scrollTo(0, 0);
  if (route.first) sec.querySelector('h1')?.focus({ preventScroll: true }); else route.first = true;
}
window.addEventListener('hashchange', route);

/* ═════════════════════════ filtros, tema, ciclo de vida ═════════════════════════ */
function syncRanges() {
  $$('[data-range] input').forEach(i => { i.checked = +i.value === S.hours; });
}
document.addEventListener('change', e => {
  if (e.target.matches('[data-range] input')) {
    S.hours = +e.target.value;
    store.set('rio-range', String(S.hours));
    syncRanges();
    loadAll();
  } else if (e.target.id === 'gauge') {
    S.gauge = +e.target.value;
    loadAll();
  }
});

const themeIsDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
};
const syncThemeBtn = () => $('#theme-ico').setAttribute('href', themeIsDark() ? '#i-sun' : '#i-moon');
$('#theme').addEventListener('click', () => {
  const next = themeIsDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set('rio-theme', next);
  syncThemeBtn();
});
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', syncThemeBtn);

let rz = 0;                                   // redesenha gráficos quando a largura muda
let lastW = 0;
new ResizeObserver(entries => {
  const w = Math.round(entries[0].contentRect.width);
  if (w === lastW) return;
  lastW = w;
  cancelAnimationFrame(rz);
  rz = requestAnimationFrame(() => renderView(S.view));
}).observe($('#main'));

(async function start() {
  syncThemeBtn();
  syncRanges();
  route();
  try { S.cfg = { ...S.cfg, ...(await getJSON('/api/config')) }; } catch { /* usa os padrões */ }
  try { const l = await getJSON('/api/latest'); S.latest = l.ts ? l : null; } catch { /* ainda sem registro */ }
  connectLive();
  await loadAll();
  renderAll();
})();
setInterval(loadAll, 30000);
setInterval(() => { if (S.loaded) { renderChrome(); if (S.view === 'overview') { renderSituation(); renderKpis(); renderSources(); } } }, 30000);   // "há X min" continua andando
