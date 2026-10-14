// Traduz os dados em uma situação, em linguagem simples, mostrando o raciocínio.
// Funções puras: recebem dados, devolvem texto e estado. Nada de DOM aqui.
import { m2, num } from './util.js';

/** Escala de chuva acumulada em 24 h (a mesma faixa de cores do Mapa Interativo do CEMADEN). */
export const RAIN_SCALE = [
  { max: 1, id: 'none', label: 'Sem chuva relevante', range: 'menos de 1 mm' },
  { max: 10, id: 'light', label: 'Chuva fraca', range: '1 a 10 mm' },
  { max: 30, id: 'moderate', label: 'Chuva moderada', range: '10 a 30 mm' },
  { max: 70, id: 'heavy', label: 'Chuva forte', range: '30 a 70 mm' },
  { max: Infinity, id: 'extreme', label: 'Chuva muito forte', range: '70 mm ou mais' },
];
export const rainClass = mm => RAIN_SCALE.find(c => mm < c.max) || RAIN_SCALE[RAIN_SCALE.length - 1];

/** Os estados possíveis. `tone` casa com as cores de status do painel; ícone + rótulo sempre juntos. */
export const STATES = {
  normal: { tone: 'good', icon: 'check', label: 'Situação normal' },
  atencao: { tone: 'warn', icon: 'alert', label: 'Atenção' },
  alerta: { tone: 'serious', icon: 'alert', label: 'Alerta' },
  critico: { tone: 'crit', icon: 'alert', label: 'Risco de transbordamento' },
  incerto: { tone: '', icon: 'info', label: 'Nível sem confirmação' },
  semdados: { tone: '', icon: 'info', label: 'Sem dados recentes' },
};

/** Em que faixa das cotas está um nível (m). */
export function zoneOf(nivel, cotas) {
  if (nivel == null || !cotas) return null;
  if (cotas.transbordamento != null && nivel >= cotas.transbordamento) return 'transbordamento';
  if (cotas.alerta != null && nivel >= cotas.alerta) return 'alerta';
  if (cotas.atencao != null && nivel >= cotas.atencao) return 'atencao';
  return 'normal';
}

/**
 * ctx = {
 *   hidro:  resumo da estação do CEMADEN (nivel_m, estavel, classe, variacao_m, defasado, cotas)
 *   trend:  { delta1h } variação da mediana na última hora (m), ou null
 *   rain:   { nome, acc1, acc24 } do pluviômetro mais próximo, ou null
 *   forecast6h: mm previstos (Open-Meteo), ou null
 *   cam:    { state: 'on'|'off'|'wait', level_pct, conf }
 *   alerts: [{ ts(ms) }]   now: ms
 * }
 * Devolve { id, ...STATES[id], headline, summary, reasons[{kind:'ok'|'warn'|'info', text}] }
 */
export function assess(ctx) {
  const { hidro, trend, rain, forecast6h, cam, alerts = [], now = Date.now() } = ctx;
  const parts = [], reasons = [];
  const c = hidro?.cotas || {};
  const usable = !!(hidro && hidro.nivel_m != null && !hidro.defasado);
  let id;

  // 1) o rio
  if (!usable) {
    id = 'semdados';
    parts.push('A estação do CEMADEN não enviou uma leitura recente do nível do rio.');
    reasons.push({ kind: 'warn', text: 'Sem leitura recente de nível na estação do CEMADEN.' });
  } else if (!hidro.estavel) {
    id = 'incerto';
    parts.push(`A estação do CEMADEN indica cerca de ${m2(hidro.nivel_m)} m (mediana da última hora), mas o sensor oscilou ${m2(hidro.variacao_m)} m nesse período. Por isso o nível não pode ser classificado com segurança.`);
    reasons.push({ kind: 'warn', text: `Sensor oscilando: variação de ${m2(hidro.variacao_m)} m na última hora (acima de 0,5 m não dá para confiar).` });
  } else {
    id = { normal: 'normal', atencao: 'atencao', alerta: 'alerta', transbordamento: 'critico' }[hidro.classe] || 'incerto';
    const m = m2(hidro.nivel_m);
    parts.push({
      normal: `O rio está em ${m} m, abaixo da cota de atenção (${m2(c.atencao)} m).`,
      atencao: `O rio está em ${m} m, na faixa de atenção (a partir de ${m2(c.atencao)} m).`,
      alerta: `O rio está em ${m} m, na faixa de alerta (a partir de ${m2(c.alerta)} m).`,
      transbordamento: `O rio está em ${m} m, acima da cota de transbordamento (${m2(c.transbordamento)} m).`,
    }[hidro.classe] || `O rio está em ${m} m.`);
    reasons.push({ kind: id === 'normal' ? 'ok' : 'warn', text: `Nível estável em ${m} m, classificado pelas cotas da estação.` });
    if (trend?.delta1h != null && Math.abs(trend.delta1h) >= 0.1) {
      const up = trend.delta1h > 0;
      parts.push(`O nível ${up ? 'subiu' : 'caiu'} ${m2(Math.abs(trend.delta1h))} m na última hora.`);
      reasons.push({ kind: up ? 'warn' : 'info', text: `Variação na última hora: ${up ? '+' : '−'}${m2(Math.abs(trend.delta1h))} m.` });
    }
  }

  // 2) chuva medida
  let heavy = false;
  if (rain && rain.acc24 != null) {
    const rc = rainClass(rain.acc24);
    heavy = rain.acc24 >= 30 || (rain.acc1 ?? 0) >= 10;
    if (rain.acc24 < 1) parts.push('Não houve chuva relevante nas últimas 24 h.');
    else parts.push(`Choveu ${num(rain.acc24, 1)} mm nas últimas 24 h (${rc.label.toLowerCase()})${(rain.acc1 ?? 0) > 0 ? `, sendo ${num(rain.acc1, 1)} mm na última hora` : ''}.`);
    reasons.push({ kind: heavy ? 'warn' : 'ok', text: `Chuva medida em 24 h: ${num(rain.acc24, 1)} mm (${rc.label.toLowerCase()}), pluviômetro ${rain.nome}.` });
  }

  // 3) previsão
  if (forecast6h != null) {
    if (forecast6h >= 1) parts.push(`A previsão é de ${num(forecast6h, 1)} mm nas próximas 6 h.`);
    else parts.push('Não há chuva prevista para as próximas 6 h.');
    reasons.push({ kind: forecast6h >= 10 ? 'warn' : 'ok', text: `Previsão para as próximas 6 h: ${num(forecast6h, 1)} mm (modelo, não é medição).` });
  }

  // chuva forte + nível sem confirmação: não dá para dizer "normal"
  if (id === 'incerto' && (heavy || (forecast6h ?? 0) >= 30)) {
    id = 'atencao';
    reasons.unshift({ kind: 'warn', text: 'Chuva forte (medida ou prevista) somada ao sensor instável: acompanhe o nível.' });
  }

  // 4) câmera
  if (cam?.state === 'off') {
    parts.push('A câmera está sem sinal.');
    reasons.push({ kind: 'info', text: 'Câmera sem sinal: sem imagem nem contagem de pessoas e veículos.' });
  } else if (cam?.level_pct != null) {
    const ok = (cam.conf ?? 0) >= 0.5;
    reasons.push({ kind: 'info', text: ok
      ? `A câmera estima ${num(cam.level_pct, 0)}% da régua (confiança ${num((cam.conf ?? 0) * 100, 0)}%).`
      : `A leitura da câmera tem confiança baixa (${num((cam.conf ?? 0) * 100, 0)}%) e não entra na decisão.` });
  }

  // 5) alertas recentes
  const recent = alerts.filter(a => now - a.ts <= 6 * 3600e3).length;
  if (recent) {
    parts.push(`Há ${recent} ${recent === 1 ? 'alerta' : 'alertas'} nas últimas 6 horas.`);
    reasons.push({ kind: 'warn', text: `${recent} ${recent === 1 ? 'alerta registrado' : 'alertas registrados'} nas últimas 6 horas.` });
  }

  const st = STATES[id];
  return { id, ...st, headline: st.label, summary: parts.join(' '), reasons };
}
