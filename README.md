# Monitor Rio Caratinga

Lê a câmera do rio (CDL Caratinga) **ao vivo** e analisa:

- **Nível do rio**: % de uma "régua" que você marca na imagem (pode virar metros).
- **Movimento**: contagem de pessoas, carros, motos, ônibus etc. (YOLOv8) e % de mudança entre capturas.
- **Tempo**: dia/noite e visibilidade pela imagem, mais temperatura e chuva (últimas 24 h e próximas 6 h) do Open-Meteo.
- **Histórico**: a cada `INTERVAL_SECONDS` grava no SQLite, com painel web e gráficos.
- **CEMADEN**: nível do rio e chuva medidos pelas estações oficiais mais próximas da câmera (dados abertos).
- **Alertas** (opcional): Telegram quando o nível passa do limite ou sobe rápido.
- **IA de visão** (opcional): um modelo multimodal dá uma segunda leitura (normal / elevado / transbordando).

## Subir

```bash
cp .env.example .env      # ajuste o que quiser
docker compose up -d --build
```

Painel em http://localhost:8090. Logs: `docker compose logs -f worker`.

### Tempo real

O worker mantém um `ffmpeg` aberto no stream. O painel mostra o vídeo anotado (`/live.mjpg`, `LIVE_FPS` quadros/s) e os cartões atualizam por Server-Sent Events (`/api/live`), sem recarregar. O selo **ao vivo / sem sinal** acende conforme chegam leituras.

- A câmera entrega HLS, que já tem alguns segundos de atraso próprio; o painel não consegue ficar abaixo disso.
- `LIVE_FPS` e `ANALYSIS_INTERVAL_SECONDS` controlam o custo de CPU. O YOLO é a parte cara: se pesar, aumente o intervalo ou use `ENABLE_YOLO=false`.
- Histórico e gráficos continuam no ritmo de `INTERVAL_SECONDS`. Cada snapshot (largura `LIVE_WIDTH`, 1280 por padrão) tem ~0,2–0,3 MB: com `INTERVAL_SECONDS=60` e 7 dias são alguns GB, então ajuste `INTERVAL_SECONDS` ou `KEEP_SNAPSHOTS_DAYS` se precisar.

O build baixa o Chromium (para achar o `.m3u8` atrás do player) e o PyTorch CPU, então a imagem fica grande (~2–3 GB). Se não quiser contagem de pessoas e veículos, use `ENABLE_YOLO=false`.

## CEMADEN

O worker consulta a cada `CEMADEN_INTERVAL_SECONDS` os arquivos públicos que o Mapa Interativo do CEMADEN usa (sem chave nem cadastro) e guarda tudo no SQLite, com horário local:

- **Estação hidrológica** mais próxima (em Caratinga, "Rio Caratinga", a ~100 m da câmera): nível em metros, com as cotas oficiais de atenção, alerta e transbordamento.
- **Pluviômetros** mais próximos (até 3, num raio de `CEMADEN_RADIUS_KM`): chuva horária e acumulada em 1 h, 6 h, 24 h, 72 h…

Para fixar estações específicas, use `CEMADEN_HIDRO_ID` e `CEMADEN_PLUVIO_IDS` (ids que aparecem em `https://resources.cemaden.gov.br/dados/311_24.json`). Para desligar: `CEMADEN_ENABLED=false`.

Limites do dado, que o painel já mostra:

- O sensor de nível dessa estação **oscila muito** (saltos de ~1 m entre leituras de 10 min, sem chuva). Por isso o painel usa a **mediana da última hora** e diz "Sensor instável" quando a oscilação passa de 0,5 m, em vez de classificar em Normal/Alerta. Os alertas do Telegram **não** usam esse nível, pelo mesmo motivo.
- Os dados chegam com 10–30 min de atraso e o servidor do CEMADEN guarda cerca de 4 dias; o histórico completo fica no seu banco a partir da primeira coleta.
- O CEMADEN publica em UTC; tudo é convertido para o horário local.

## Calibrar (faça uma vez)

A leitura do nível depende de dois pontos na imagem:

1. **Régua**: uma linha vertical num lugar onde a água encosta num pilar, muro ou barranco. `y_top` é o nível mais alto que interessa (100%) e `y_bottom` o mais baixo (0%).
2. **Amostra de água**: um retângulo que é **sempre água**, mesmo com o rio no nível mais baixo. É a cor de referência.

```bash
docker compose run --rm worker python -m app.calibrate snapshot
```

Gera `data/calib.jpg` com uma grade de coordenadas e cria `data/calibration.json`. Edite os números:

```json
{
  "gauge": {"x": 640, "y_top": 200, "y_bottom": 650, "width": 24},
  "water_sample": {"x": 500, "y": 600, "w": 80, "h": 40},
  "meters": [{"pct": 0, "m": 0.5}, {"pct": 100, "m": 4.0}],
  "count_zone": [[0,300],[1280,300],[1280,720],[0,720]]
}
```

- `meters` (opcional): se souber a altura real de dois pontos da régua, o painel mostra em metros.
- `count_zone` (opcional): polígono para contar só quem está numa área (rua, ponte).

Teste a calibração:

```bash
docker compose run --rm worker python -m app.calibrate test
```

Confira `data/calib_test.jpg`: a linha vermelha precisa cair na linha d'água.

## Limites

- **À noite** a leitura por cor é desligada (retorna sem valor), porque sem iluminação água e muro ficam iguais. A IA de visão ajuda um pouco, mas o ideal é câmera com infravermelho ou um poste iluminando a régua.
- Reflexo forte, chuva na lente e mudança de ângulo da câmera atrapalham. Se a câmera mexer, recalibre.
- Alertas só disparam com confiança ≥ 50%, para não avisar por leitura ruim.
- A câmera é da CDL Caratinga. Para uso público ou comercial dos dados, peça autorização.

## Estrutura

```
app/
  stream.py         acha o .m3u8 (Playwright) e captura frame (ffmpeg)
  analyze_river.py  nível por cor na régua + checagem por IA
  analyze_scene.py  YOLO, movimento, tempo (imagem + Open-Meteo)
  cemaden.py        coleta e filtro dos dados abertos do CEMADEN
  alerts.py         regras e Telegram
  db.py             SQLite
  worker.py         loop ao vivo + gravação do histórico
  web.py            API + arquivos do painel (static/)
  calibrate.py      ajuda na calibração
  static/
    index.html      estrutura das seções
    css/app.css     tokens, componentes e layout responsivo
    js/app.js       dados, rotas e telas
    js/situation.js regras da situação em linguagem simples
    js/charts.js    gráficos SVG (linhas, colunas, tabela)
    js/glossary.js  explicações dos termos
    js/util.js      DOM, formatação pt-BR, CSV
data/               banco, capturas anotadas e calibração (volume)
```

API: `/api/live.json` (leitura ao vivo, usada pelo painel), `/snap/latest.jpg` (último quadro), `/api/live` (SSE) e `/live.mjpg` (vídeo contínuo, para uso externo), `/api/cemaden`, `/api/cemaden/series?hours=24` e `/api/cemaden/zones?days=7`, `/api/latest`, `/api/readings?hours=24[&points=360]`, `/api/alerts`, `/api/config`, `/snap/latest.jpg`.

## Painel

Aplicação de uma página (sem dependências externas, funciona offline na rede local) pensada para quem **analisa e precisa entender** os dados. Cabeçalho com a última medição e a **contagem regressiva** da próxima coleta, e cinco seções em pílulas:

- **Dashboard**: a situação em linguagem simples (com "Por que este status?"), quatro indicadores com variação, **como o rio passou o tempo** (rosca por faixa de cota, com a parcela de leituras confiáveis), **horas em cada faixa por dia** (dias com dados parciais sombreados), nível × chuva lado a lado, **radar dos pluviômetros**, câmera, eventos e a confiança em cada fonte.
- **Rio**: nível medido pela estação do CEMADEN, com as cotas desenhadas como faixas coloridas no gráfico, estatísticas do período e a comparação com a câmera.
- **Chuva**: chuva por hora, acumulado por pluviômetro (escolha o pluviômetro), previsão e a escala de classificação.
- **Câmera**: vídeo ao vivo, pessoas e veículos, nível estimado e como ler as marcações da imagem.
- **Regras e dados**: fonte, frequência e limitação de cada dado, download em CSV, regras do status e glossário.

O painel **não mantém conexões permanentes**: dados e vídeo vêm de requisições curtas (cerca de 1 por segundo e 3 quadros por segundo). Navegadores limitam 6 conexões por endereço, e SSE/MJPEG em várias abas travavam tudo.

Cada número técnico tem um botão **?** que explica o termo. Todo gráfico tem a versão em tabela. Tema claro e escuro; estados sempre com ícone e texto, nunca só cor.

A situação ("Situação normal", "Atenção", "Alerta", "Risco de transbordamento", "Nível alto, sem chuva que o explique", "Nível sem confirmação", "Sem dados recentes") vem de regras simples e visíveis em `app/static/js/situation.js`. Em especial: nível em alerta ou transbordamento **sem nenhuma chuva medida em 3 dias** não vira "cheia" nem é descartado, e o painel pede confirmação, porque o sensor da estação às vezes registra eco falso. O painel é apoio à decisão e **não substitui** os avisos da Defesa Civil.

## Estrutura

```
app/
  stream.py         acha o .m3u8 (Playwright) e captura frame (ffmpeg)
  analyze_river.py  nível por cor na régua + checagem por IA
  analyze_scene.py  YOLO, movimento, tempo (imagem + Open-Meteo)
  cemaden.py        coleta e filtro dos dados abertos do CEMADEN
  alerts.py         regras e Telegram
  db.py             SQLite
  worker.py         loop ao vivo + gravação do histórico
  web.py            API + arquivos do painel (static/)
  calibrate.py      ajuda na calibração
  static/
    index.html      estrutura das seções
    css/app.css     tokens, componentes e layout responsivo
    js/app.js       dados, rotas e telas
    js/situation.js regras da situação em linguagem simples
    js/charts.js    gráficos SVG (linhas, colunas, tabela)
    js/glossary.js  explicações dos termos
    js/util.js      DOM, formatação pt-BR, CSV
data/               banco, capturas anotadas e calibração (volume)
```

API: `/api/live` (SSE), `/live.mjpg` (vídeo), `/api/cemaden`, `/api/cemaden/series?hours=24` e `/api/cemaden/zones?days=7`, `/api/latest`, `/api/readings?hours=24[&points=360]`, `/api/alerts`, `/api/config`, `/snap/latest.jpg`.

## Painel

Aplicação de uma página (sem dependências externas, funciona offline na rede local) pensada para quem **analisa e precisa entender** os dados. Cinco seções, com navegação lateral no computador e barra inferior no celular:

- **Visão geral**: a situação agora em linguagem simples (com "Por que este status?"), indicadores principais, nível × chuva lado a lado, câmera, eventos e a confiança em cada fonte.
- **Rio**: nível medido pela estação do CEMADEN, com as cotas desenhadas como faixas coloridas no gráfico, estatísticas do período e a comparação com a câmera.
- **Chuva**: chuva por hora, acumulado por pluviômetro (escolha o pluviômetro), previsão e a escala de classificação.
- **Câmera**: vídeo ao vivo, pessoas e veículos, nível estimado e como ler as marcações da imagem.
- **Dados e ajuda**: fonte, frequência e limitação de cada dado, download em CSV, regras do status e glossário.

Cada número técnico tem um botão **?** que explica o termo. Todo gráfico tem a versão em tabela e o cursor sincronizado entre nível e chuva. Tema claro e escuro; estados sempre com ícone e texto, nunca só cor.

A situação ("Situação normal", "Atenção", "Alerta", "Risco de transbordamento", "Nível sem confirmação", "Sem dados recentes") vem de regras simples e visíveis em `app/static/js/situation.js` (função pura, fácil de testar). O painel é apoio à decisão e **não substitui** os avisos da Defesa Civil.

## Estrutura

```
app/
  stream.py         acha o .m3u8 (Playwright) e captura frame (ffmpeg)
  analyze_river.py  nível por cor na régua + checagem por IA
  analyze_scene.py  YOLO, movimento, tempo (imagem + Open-Meteo)
  cemaden.py        coleta e filtro dos dados abertos do CEMADEN
  alerts.py         regras e Telegram
  db.py             SQLite
  worker.py         loop ao vivo + gravação do histórico
  web.py            API + arquivos do painel (static/)
  calibrate.py      ajuda na calibração
  static/
    index.html      estrutura das seções
    css/app.css     tokens, componentes e layout responsivo
    js/app.js       dados, rotas e telas
    js/situation.js regras da situação em linguagem simples
    js/charts.js    gráficos SVG (linhas, colunas, tabela)
    js/glossary.js  explicações dos termos
    js/util.js      DOM, formatação pt-BR, CSV
data/               banco, capturas anotadas e calibração (volume)
```

API: `/api/live` (SSE), `/live.mjpg` (vídeo), `/api/cemaden`, `/api/cemaden/series?hours=24` e `/api/cemaden/zones?days=7`, `/api/latest`, `/api/readings?hours=24[&points=360]`, `/api/alerts`, `/api/config`, `/snap/latest.jpg`.

## Painel

Uma página só (`app/static/index.html`), sem dependências externas, que funciona offline na rede local:

- **Nível do rio** em destaque, com medidor e linha do limite de alerta (`ALERT_LEVEL_PCT`). O status sempre vem com ícone e texto: *Normal*, *Atenção*, *Nível alto* ou *Leitura incerta* (confiança abaixo de 50%).
- **Indicadores ao vivo** de pessoas, veículos, movimento, tempo e chuva, cada um com mini-gráfico das últimas 6 h.
- **Gráficos** de nível, pessoas/veículos e chuva para 6 h, 24 h, 3 ou 7 dias. Passe o mouse (ou use as setas do teclado) para ver os valores; o botão de tabela mostra os mesmos dados em texto.
- **Tema** claro/escuro (segue o sistema; o botão no topo fixa a escolha) e layout para celular, tablet e desktop.
- Se o stream cair, o selo muda para **Sem sinal** e o vídeo escurece; quando volta, reconecta sozinho.
