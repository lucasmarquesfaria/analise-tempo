// Gráficos em SVG puro: sem biblioteca, sem rede. Seguem as regras de visualização do painel:
// linhas de 2 px, colunas finas com ponta arredondada, grade discreta, cruzeta + tooltip,
// legenda quando há 2+ séries e uma tabela equivalente para cada gráfico.
import { h, sv } from './util.js';

/* ── cursor sincronizado entre gráficos do mesmo grupo (nível × chuva) ── */
const groups = {};
function register(name, host, api) {
  if (!name) return;
  const g = (groups[name] ??= new Map());
  for (const el of g.keys()) if (!el.isConnected) g.delete(el);
  g.set(host, api);
}
const broadcast = (name, t) => groups[name]?.forEach(a => a.focusAt(t));
const clearAll = name => groups[name]?.forEach(a => a.blur());

export function niceMax(v, steps = 4, int = false) {
  if (v <= 0) return { max: steps, step: 1 };
  const raw = v / steps, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  let step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
  if (int) step = Math.max(1, Math.ceil(step));
  return { max: step * steps, step };
}

function tooltip(host) {
  const tip = h('div', { class: 'tip', role: 'status' });
  tip.hidden = true;
  host.append(tip);
  return {
    show(x, W, top, title, items) {
      tip.replaceChildren(h('div', { class: 'tip-t' }, title));
      for (const it of items) {
        const k = h('i', { class: 'key' });
        k.style.background = `var(${it.color})`;
        tip.append(h('div', { class: 'tip-r' }, k, h('strong', {}, it.value), h('span', {}, it.label)));
      }
      tip.hidden = false;
      const w = tip.offsetWidth;
      tip.style.transform = `translate(${Math.max(4, x + 14 + w > W ? x - 14 - w : x + 14)}px, ${top}px)`;
    },
    hide() { tip.hidden = true; },
  };
}

function nearestIdx(times, t) {
  let lo = 0, hi = times.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] < t) lo = mid; else hi = mid; }
  return Math.abs(times[lo] - t) <= Math.abs(times[hi] - t) ? lo : hi;
}

function axes(svg, o, m, W, H, Y, yMax, step, yFmt) {
  for (let v = 0; v <= yMax + 1e-9; v += step) {
    const y = Y(v);
    sv('line', { class: v === 0 ? 'ax' : 'gl', x1: m.l, x2: W - m.r, y1: y, y2: y }, svg);
    sv('text', { x: m.l - 8, y: y + 4, 'text-anchor': 'end' }, svg).textContent = yFmt(v);
  }
  const pw = W - m.l - m.r, nx = Math.max(2, Math.min(6, Math.floor(pw / 120)));
  for (let i = 0; i < nx; i++) {
    const t = o.t0 + (o.t1 - o.t0) * i / (nx - 1);
    const x = m.l + (t - o.t0) / (o.t1 - o.t0) * pw;
    sv('text', { x, y: H - 8, 'text-anchor': i === 0 ? 'start' : i === nx - 1 ? 'end' : 'middle' }, svg).textContent = o.xFmt(t);
  }
}

/**
 * Linhas. o = { rows:[{t,...}], series:[{key,label,color,faint}], hidden:{}, t0, t1, xFmt, yFmt, valFmt,
 *   yMax?, yStep?, int?, thresholds:[{v,label,below}], bands:[{from,to,color,label}], area, endLabel,
 *   mr (margem direita), sync (grupo do cursor), aria }
 */
export function lineChart(host, o) {
  host.replaceChildren();
  const W = host.clientWidth, H = host.clientHeight;
  if (W < 60 || H < 60) return;
  const hidden = o.hidden || {};
  const vis = o.series.filter(s => !hidden[s.key]);
  const rows = o.rows;
  const m = { l: 42, r: o.mr ?? (o.endLabel ? 60 : 16), t: 14, b: 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;

  let yMax = o.yMax, step = o.yStep;
  if (yMax == null) {
    const mx = Math.max(0, ...rows.flatMap(r => o.series.map(s => r[s.key] ?? 0)), ...(o.thresholds || []).map(x => x.v * 1.04));
    ({ max: yMax, step } = niceMax(mx, 4, o.int));
  }
  const X = t => m.l + (t - o.t0) / (o.t1 - o.t0) * pw;
  const Y = v => m.t + ph - Math.max(0, Math.min(yMax, v)) / yMax * ph;
  const base = Y(0);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', tabindex: 0, 'aria-label': o.aria }, host);

  // zonas (cotas): fundo colorido por faixa, para ver de relance em qual zona o rio esteve
  for (const b of o.bands || []) {
    const top = Y(Math.min(b.to ?? yMax, yMax)), bot = Y(Math.max(b.from, 0));
    if (bot - top < 1) continue;
    sv('rect', { x: m.l, y: top, width: pw, height: bot - top, fill: `var(${b.color})`, opacity: b.opacity ?? 0.09 }, svg);
    if (b.label && bot - top > 16) sv('text', { class: 'zone', x: m.l + 8, y: top + 14 }, svg).textContent = b.label;
  }
  axes(svg, o, m, W, H, Y, yMax, step, o.yFmt);

  const refs = o.thresholds || [];
  for (const r of refs) {
    if (r.v > yMax) continue;
    const y = Y(r.v);
    sv('line', { class: 'ref', x1: m.l, x2: W - m.r, y1: y, y2: y }, svg);
    sv('text', { class: 'halo', x: W - m.r - 4, y: r.below ? y + 15 : y - 5, 'text-anchor': 'end' }, svg).textContent = r.label;
  }

  // segmentos contínuos: buraco no dado vira buraco no gráfico
  const dts = rows.slice(1).map((r, i) => r.t - rows[i].t).sort((a, b) => a - b);
  const gap = Math.max((dts[dts.length >> 1] || 60e3) * 4, 5 * 60e3);
  for (const s of vis) {
    const segs = []; let cur = null, prev = null;
    for (const r of rows) {
      const v = r[s.key];
      if (v == null) { cur = null; continue; }
      if (!cur || r.t - prev > gap) { cur = []; segs.push(cur); }
      cur.push([X(r.t), Y(v)]); prev = r.t;
    }
    const multi = segs.filter(g => g.length > 1);
    if (o.area && !s.faint && multi.length) {
      sv('path', { d: multi.map(g => `M${g[0][0].toFixed(1)} ${base}` + g.map(p => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')
        + `L${g[g.length - 1][0].toFixed(1)} ${base}Z`).join(''), fill: `var(${s.color})`, opacity: 0.1 }, svg);
    }
    sv('path', { d: multi.map(g => g.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')).join(''),
      fill: 'none', stroke: `var(${s.color})`, 'stroke-width': s.faint ? 1.5 : 2, opacity: s.faint ? 0.4 : 1,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
    for (const g of segs) if (g.length === 1) sv('circle', { cx: g[0][0], cy: g[0][1], r: 3, fill: `var(${s.color})` }, svg);
  }

  // ponta da série: marcador com anel + valor (só quando não colide com outro)
  const ends = vis.filter(s => !s.faint).map(s => {
    const r = [...rows].reverse().find(x => x[s.key] != null);
    return r ? { s, x: X(r.t), y: Y(r[s.key]), v: r[s.key] } : null;
  }).filter(Boolean);
  for (const e of ends) sv('circle', { class: 'ring', cx: e.x, cy: e.y, r: 4, fill: `var(${e.s.color})` }, svg);
  if (o.endLabel) {
    const ys = ends.map(e => e.y).sort((a, b) => a - b);
    if (!ys.some((y, i) => i && y - ys[i - 1] < 15))
      for (const e of ends) sv('text', { class: 'val', x: e.x + 10, y: e.y + 4 }, svg).textContent = o.valFmt(e.v);
  }

  // hover: a cruzeta encontra o X; um tooltip lista todas as séries
  const times = rows.map(r => r.t);
  const cross = sv('line', { class: 'cross', y1: m.t, y2: base }, svg); cross.style.display = 'none';
  const dots = vis.map(s => { const c = sv('circle', { class: 'ring', r: 4, fill: `var(${s.color})` }, svg); c.style.display = 'none'; return c; });
  const tip = tooltip(host);
  let cursor = rows.length - 1;
  const show = i => {
    if (!rows.length) return;
    cursor = Math.max(0, Math.min(rows.length - 1, i));
    const r = rows[cursor], x = X(r.t), items = [];
    cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.style.display = '';
    vis.forEach((s, j) => {
      const v = r[s.key];
      dots[j].style.display = v == null ? 'none' : '';
      if (v != null) { dots[j].setAttribute('cx', x); dots[j].setAttribute('cy', Y(v)); }
      items.push({ color: s.color, value: v == null ? '—' : o.valFmt(v), label: s.label });
    });
    tip.show(x, W, m.t, o.tipTitle ? o.tipTitle(r.t) : String(r.t), items);
  };
  const hide = () => { cross.style.display = 'none'; dots.forEach(d => { d.style.display = 'none'; }); tip.hide(); };
  register(o.sync, host, { focusAt: t => rows.length && show(nearestIdx(times, t)), blur: hide });

  const at = e => o.t0 + ((e.clientX - svg.getBoundingClientRect().left) - m.l) / pw * (o.t1 - o.t0);
  const follow = e => {
    if (!rows.length) return;
    const t = at(e);
    if (o.sync) broadcast(o.sync, t); else show(nearestIdx(times, t));
  };
  const leave = () => (o.sync ? clearAll(o.sync) : hide());
  svg.addEventListener('pointermove', follow);
  svg.addEventListener('pointerdown', follow);
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('focus', () => show(cursor));
  svg.addEventListener('blur', leave);
  svg.addEventListener('keydown', e => {
    const go = d => { show(cursor + d); if (o.sync) broadcast(o.sync, rows[cursor].t); e.preventDefault(); };
    if (e.key === 'ArrowLeft') go(-1);
    else if (e.key === 'ArrowRight') go(1);
    else if (e.key === 'Escape') leave();
  });
}

/**
 * Colunas (chuva). o = { rows:[{t,[key]}], key, agg:'max'|'sum', n, color, label, t0, t1, xFmt, valFmt,
 *   mr, sync, aria, zeroMsg }
 */
export function columnChart(host, o) {
  host.replaceChildren();
  const W = host.clientWidth, H = host.clientHeight;
  if (W < 60 || H < 60) return;
  const m = { l: 42, r: o.mr ?? 16, t: 22, b: 30 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const n = o.n ? Math.max(6, Math.min(o.n, Math.floor(pw / 4))) : Math.max(12, Math.min(96, Math.floor(pw / 8)));
  const bw = (o.t1 - o.t0) / n;
  const buckets = Array.from({ length: n }, (_, i) => ({ t: o.t0 + bw * (i + 0.5), v: null }));
  for (const r of o.rows) {
    const v = r[o.key];
    if (v == null) continue;
    const i = Math.min(n - 1, Math.max(0, Math.floor((r.t - o.t0) / bw)));
    buckets[i].v = o.agg === 'sum' ? (buckets[i].v ?? 0) + v : Math.max(buckets[i].v ?? 0, v);
  }
  const mx = Math.max(0, ...buckets.map(b => b.v ?? 0));
  const { max: yMax, step } = mx > 0 ? niceMax(mx, 4) : { max: 1, step: 0.25 };
  const band = pw / n, bar = Math.max(2, Math.min(24, band - 2));   // ≤ 24 px, 2 px de ar entre colunas
  const floor = m.t + ph, Y = v => floor - v / yMax * ph;
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, role: 'img', 'aria-label': o.aria }, host);
  axes(svg, o, m, W, H, Y, yMax, step, v => num2(v));

  const cross = sv('line', { class: 'cross', y1: m.t, y2: floor }, svg); cross.style.display = 'none';
  const tip = tooltip(host);
  let peak = null;
  const items = b => [{ color: o.color, value: b.v == null ? '—' : o.valFmt(+b.v.toFixed(2)), label: o.label }];
  const focus = i => {
    const b = buckets[i], cx = m.l + i * band + band / 2;
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.style.display = '';
    tip.show(cx, W, m.t, o.tipTitle ? o.tipTitle(b.t) : String(b.t), items(b));
  };
  const blur = () => { cross.style.display = 'none'; tip.hide(); };
  register(o.sync, host, {
    focusAt: t => focus(Math.max(0, Math.min(n - 1, Math.floor((t - o.t0) / bw)))), blur,
  });

  buckets.forEach((b, i) => {
    const x0 = m.l + i * band, cx = x0 + band / 2;
    const hit = sv('rect', { class: 'hit', x: x0, y: m.t, width: band, height: ph, fill: 'transparent' }, svg);
    if (b.v != null && b.v > 0) {
      if (!peak || b.v > peak.v) peak = { ...b, cx };
      const hh = Math.max(2, floor - Y(b.v)), top = floor - hh, r = Math.min(4, bar / 2, hh), x = cx - bar / 2;
      sv('path', {   // 4 px arredondado na ponta de dados, reto na linha de base
        class: 'col', fill: `var(${o.color})`,
        d: `M${x} ${floor}V${top + r}a${r} ${r} 0 0 1 ${r} ${-r}H${x + bar - r}a${r} ${r} 0 0 1 ${r} ${r}V${floor}Z`,
      }, svg);
    }
    const enter = () => { if (o.sync) broadcast(o.sync, b.t); else focus(i); hit.classList.add('on'); };
    hit.addEventListener('pointerenter', enter);
    hit.addEventListener('pointerdown', enter);
    hit.addEventListener('pointerleave', () => { (o.sync ? clearAll(o.sync) : blur()); hit.classList.remove('on'); });
  });
  if (peak) {     // rótulo só no pico; o resto fica no tooltip e na tabela
    const x = Math.min(W - m.r - 16, Math.max(m.l + 16, peak.cx));
    sv('text', { class: 'val', x, y: Y(peak.v) - 6, 'text-anchor': 'middle' }, svg).textContent = o.valFmt(+peak.v.toFixed(2));
  } else if (o.zeroMsg) host.append(h('div', { class: 'chart-empty' }, h('span', {}, o.zeroMsg)));
}
const num2 = v => new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(v);

/** Mini-gráfico de tendência (cartões). A ponta atual leva a cor; o resto fica discreto. */
export function sparkline(host, pts, colorVar) {
  host.replaceChildren();
  const v = pts.filter(x => x != null);
  if (v.length < 2) return;
  const W = host.clientWidth || 120, H = 34, p = 6;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const X = i => p + i / (pts.length - 1) * (W - 2 * p);
  const Y = x => H - p - (x - lo) / span * (H - 2 * p);
  const svg = sv('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' }, host);
  let d = '', pen = false, last = null;
  pts.forEach((x, i) => {
    if (x == null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${X(i).toFixed(1)} ${Y(x).toFixed(1)}`; pen = true; last = [X(i), Y(x)];
  });
  sv('path', { d, fill: 'none', stroke: 'var(--faint)', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }, svg);
  if (last) sv('circle', { cx: last[0], cy: last[1], r: 4, fill: `var(${colorVar})`, stroke: 'var(--surface)', 'stroke-width': 2 }, svg);
}

/** Legenda com botões: clicar oculta/mostra a série (sem repintar as outras). */
export function legend(host, items, hidden, onToggle) {
  host.replaceChildren();
  for (const it of items) {
    const b = h('button', { type: 'button', 'aria-pressed': String(!hidden[it.key]) },
      h('i', { class: 'key', style: `background:var(${it.color});${it.faint ? 'opacity:.45' : ''}` }), it.label);
    b.addEventListener('click', () => { hidden[it.key] = !hidden[it.key]; onToggle(); });
    host.append(b);
  }
}

/** Tabela: a versão em texto de cada gráfico (mais recente primeiro). */
export function tableView(host, cols, rows) {
  const body = h('tbody');
  for (const r of [...rows].reverse()) body.append(h('tr', {}, ...cols.map(c => h('td', {}, c.f(r)))));
  host.replaceChildren(h('table', {},
    h('thead', {}, h('tr', {}, ...cols.map(c => h('th', { scope: 'col' }, c.h)))), body));
}
