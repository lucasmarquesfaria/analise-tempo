// Utilitários de DOM e formatação. Sem estado, sem dependência do resto do painel.
const NS = 'http://www.w3.org/2000/svg';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/** Cria um elemento HTML. Texto entra sempre como nó de texto (nunca innerHTML). */
export function h(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) n.append(c);
  return n;
}

export function sv(tag, attrs = {}, parent) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  parent?.appendChild(n);
  return n;
}

/** Ícone do sprite definido no index.html (`<symbol id="i-nome">`). */
export function icon(name, cls = '') {
  const s = sv('svg', { class: ('i ' + cls).trim(), 'aria-hidden': 'true' });
  sv('use', { href: '#i-' + name }, s);
  return s;
}

/* ── formatação (pt-BR) ── */
const nfs = {};
export const num = (v, d = 1) => v == null || Number.isNaN(v) ? '—'
  : (nfs[d] ??= new Intl.NumberFormat('pt-BR', { maximumFractionDigits: d, minimumFractionDigits: 0 })).format(v);

/** Metros com 2 casas, sempre ("3,00"). */
const nf2 = new Intl.NumberFormat('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const m2 = v => v == null || Number.isNaN(v) ? '—' : nf2.format(v);

export const parseTs = s => new Date(String(s).replace(' ', 'T')).getTime();
export const fmtDateTime = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
export const fmtTime = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
export const fmtDate = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit' });
export const fmtFull = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'medium' });

export const cap = s => s ? s[0].toUpperCase() + s.slice(1) : s;

/** "há 3 min", "há 2 h". */
export function ago(ms, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return 'agora há pouco';
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const hr = Math.round(m / 60);
  if (hr < 36) return `há ${hr} h`;
  return `há ${Math.round(hr / 24)} d`;
}
export const agoMin = (min) => min == null ? '—' : ago(Date.now() - min * 60000);

/** Plural simples: plural(2, 'carro', 'carros'). */
export const plural = (n, one, many) => (n === 1 ? one : many);

/* ── armazenamento local (nunca quebra se estiver bloqueado) ── */
export const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* segue sem lembrar */ } },
};

/* ── CSV (separador ";" e vírgula decimal, como o Excel em pt-BR espera) ── */
export function toCsv(cols, rows) {
  const esc = v => {
    const t = v == null ? '' : typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[;"\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
  };
  return '﻿' + [cols.map(c => esc(c.h)).join(';'), ...rows.map(r => cols.map(c => esc(c.v(r))).join(';'))].join('\r\n');
}
export function download(name, text, type = 'text/csv;charset=utf-8') {
  const a = h('a', { href: URL.createObjectURL(new Blob([text], { type })), download: name });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
}
