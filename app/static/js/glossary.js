// Explicações em linguagem simples. Cada termo aparece num botão "?" ao lado do número
// e no glossário da seção "Dados e ajuda".
export const GLOSSARY = {
  status: {
    title: 'Como a situação é definida',
    short: 'Resume nível, chuva, previsão e câmera em um estado só.',
    body: [
      'A situação é calculada pelo painel com regras simples e visíveis, nesta ordem:',
      '1. O nível do rio na estação do CEMADEN, comparado às cotas da própria estação: normal, atenção, alerta ou transbordamento.',
      '2. Se o sensor da estação estiver oscilando, o nível não é classificado: o estado vira "Nível sem confirmação" e o painel diz por quê.',
      '3. Chuva forte (medida ou prevista) com o sensor instável eleva o estado para "Atenção", porque não dá para descartar a subida.',
      '4. Nível em alerta ou transbordamento sem nenhuma chuva medida em 3 dias não é tratado como cheia confirmada: vira "Nível alto, sem chuva que o explique", para você conferir pela câmera ou pelos avisos oficiais.',
      'A câmera e os alertas entram no texto de apoio, mas não mudam o estado sozinhos. Este painel é uma ferramenta de apoio e não substitui os avisos oficiais da Defesa Civil e do CEMADEN.',
    ],
  },
  nivel: {
    title: 'Nível do rio (em metros)',
    short: 'Altura da água em relação ao zero da régua da estação.',
    body: [
      'É a altura da superfície da água medida a partir de um ponto de referência da estação do CEMADEN (o "zero da régua"). Não é a profundidade total do rio.',
      'A estação mede a distância entre o sensor e a água e calcula: nível = altura do sensor − distância medida. Quanto maior o número, mais alta está a água.',
      'O mesmo valor em outro rio ou outra estação não significa a mesma coisa: compare sempre com as cotas da própria estação.',
    ],
  },
  cotas: {
    title: 'Cotas: atenção, alerta e transbordamento',
    short: 'Alturas de referência que marcam estágios crescentes de risco.',
    body: [
      'O CEMADEN define, para cada estação, três alturas de referência (cotas). Em geral:',
      'Atenção: o nível começa a exigir acompanhamento.',
      'Alerta: aumenta o risco de a água atingir áreas mais baixas perto do rio.',
      'Transbordamento: a água atinge a altura em que sai da calha do rio.',
      'No gráfico, cada faixa tem uma cor de fundo para você ver rapidamente em qual zona o rio esteve. Para orientações de segurança, siga a Defesa Civil.',
    ],
  },
  mediana: {
    title: 'Mediana da última hora',
    short: 'O valor do meio das leituras de 1 hora; ignora picos isolados.',
    body: [
      'Se o sensor registra 1,6 m, 2,7 m, 1,7 m, 1,6 m e 2,7 m, a mediana é 1,7 m: é o valor que fica no meio quando as leituras são colocadas em ordem.',
      'Usamos a mediana porque ela não se deixa levar por leituras isoladas e erradas, que acontecem neste sensor.',
    ],
  },
  oscilacao: {
    title: 'Oscilação e "sensor instável"',
    short: 'Quanto as leituras variaram na última hora.',
    body: [
      'Medimos a diferença entre as leituras altas e baixas da última hora (descartando os 10% mais extremos de cada lado).',
      'Um rio não sobe e desce mais de meio metro em poucos minutos sem chuva. Quando a oscilação passa de 0,5 m, tratamos o sensor como instável: o número aparece, mas a classificação por cotas fica suspensa.',
      'Sensores de nível por ultrassom podem registrar ecos falsos (de pontes, vegetação, chuva forte ou insetos), o que explica esse tipo de oscilação.',
    ],
  },
  pluviometro: {
    title: 'Pluviômetro',
    short: 'Equipamento que mede a chuva, em milímetros.',
    body: [
      'Cada milímetro equivale a 1 litro de água por metro quadrado. O painel mostra o acumulado em janelas de 1, 6, 24 e 72 horas, medido pelas estações oficiais do CEMADEN mais próximas da câmera.',
      'A chuva pode ser bem diferente entre pontos a poucos quilômetros: por isso a distância de cada pluviômetro aparece na tabela.',
    ],
  },
  'escala-chuva': {
    title: 'Escala de chuva em 24 horas',
    short: 'Classificação usada para descrever o acumulado.',
    body: [
      'Menos de 1 mm: sem chuva relevante · 1 a 10 mm: fraca · 10 a 30 mm: moderada · 30 a 70 mm: forte · 70 mm ou mais: muito forte.',
      'São as mesmas faixas de cores do Mapa Interativo do CEMADEN.',
    ],
  },
  previsao: {
    title: 'Previsão de chuva',
    short: 'Estimativa de um modelo meteorológico, não uma medição.',
    body: [
      'A previsão das próximas 6 horas vem do Open-Meteo, um serviço aberto de modelos meteorológicos. Ela é uma estimativa para a região e pode errar o local e o horário da chuva.',
      'Para saber quanto choveu de fato, use a chuva medida pelos pluviômetros.',
    ],
  },
  camera: {
    title: 'Leitura de nível pela câmera',
    short: 'Estimativa feita por visão computacional na imagem.',
    body: [
      'O sistema compara a cor da água com a margem ao longo de uma linha vertical (a "régua" desenhada na imagem) e estima em que altura está a linha d\'água, em % da régua.',
      'Funciona só com luz (à noite é desligada) e depende de a câmera estar calibrada. É uma segunda fonte, útil para conferir a estação do CEMADEN, não a medição oficial.',
    ],
  },
  confianca: {
    title: 'Confiança da leitura da câmera',
    short: 'Quanto a imagem sustenta a estimativa (0 a 100%).',
    body: [
      'Mede quanto da régua, abaixo da linha d\'água detectada, realmente parece água. Abaixo de 50% o painel trata a leitura como incerta e não a usa para decidir o status.',
      'Confiança baixa costuma indicar que a câmera ainda não foi calibrada, reflexos, chuva na lente ou pouca luz.',
    ],
  },
  movimento: {
    title: 'Movimento na cena',
    short: 'Porcentagem da imagem que mudou de um instante para outro.',
    body: [
      'Serve como termômetro de atividade (pessoas, veículos, vento, chuva). Não mede o rio.',
    ],
  },
  atraso: {
    title: 'Atraso e horário dos dados',
    short: 'De quando são os números que você está vendo.',
    body: [
      'Os dados do CEMADEN chegam com 10 a 30 minutos de atraso, e o painel mostra "há X min" em cada fonte. O vídeo da câmera tem alguns segundos de atraso próprios.',
      'O CEMADEN publica em horário UTC; todos os horários do painel já estão convertidos para o horário de Brasília.',
    ],
  },
};

export const GLOSSARY_ORDER = ['status', 'nivel', 'cotas', 'mediana', 'oscilacao', 'pluviometro', 'escala-chuva',
  'previsao', 'camera', 'confianca', 'movimento', 'atraso'];
