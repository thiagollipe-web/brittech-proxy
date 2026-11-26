// Brittech Educação — proxy entre o MVP (navegador) e as APIs de IA.
// Por que existe: a Maritaca e a DeepSeek não enviam cabeçalhos CORS, então
// o navegador bloqueia a chamada direta do MVP ("Failed to fetch"). O proxy
// fica no servidor, chama a API com a chave (que NUNCA sai do servidor) e
// devolve só o texto ao navegador.
//
// Só dependências da biblioteca padrão do Node.js — nada para instalar.
// Rode com:  node server.js
//
// Variáveis de ambiente:
//   PORT               porta do proxy (padrão 8787)
//   MARITACA_API_KEY   chave da Maritaca (provedor "maritaca")
//   DEEPSEEK_API_KEY   chave da DeepSeek (provedor "deepseek")
//   GEMINI_API_KEY     chave do Gemini  (provedor "gemini" e Live API)
//   GEMINI_LIVE_MODEL  modelo Live do Gemini (padrão: gemini-3.8-live)
//   GEMINI_LIVE_VOZ    voz do professor na Live API (padrão: Aoede)
//   MARITACA_MODEL     modelo da Maritaca (padrão: sabia-4-thinking)
//   DEEPSEEK_MODEL     modelo da DeepSeek (padrão: deepseek-chat)
//   GEMINI_MODEL       modelo do Gemini  (padrão: gemini-2.5-flash-lite)
//   ALLOWED_ORIGINS    origens liberadas no CORS, separadas por vírgula
//                      (padrão: http://localhost:*, http://127.0.0.1:* e
//                      https://thiagollipe-web.github.io)
//   TELEGRAM_BOT_TOKEN token do bot do Telegram (@BotFather) — sem ele,
//                      o bot fica inerte e o resto do proxy não muda
//   TELEGRAM_WEBHOOK_URL URL do webhook (padrão: a URL do Render)
//   TELEGRAM_WEBHOOK_SECRET segredo opcional do webhook (valida o Telegram)
//   TELEGRAM_AUTO_REGISTRO '0' desliga o registro automático do webhook
//   TELEGRAM_LIMITE_PLANOS_DIA limite diário de planos/doc por usuário (5)
//   TELEGRAM_LIMITE_MSGS_DIA limite diário de mensagens por usuário (30)
// NUNCA coloque uma chave neste arquivo nem em nenhum arquivo do repositório.

'use strict';

const http = require('http');
const { postJson, erroSeguro, chamarProvedorOpenAI } = require('./ia');
const { sintetizar } = require('./edge-tts'); // vozes neurais Edge TTS (grátis)
const telegram = require('./telegram'); // Brito no Telegram (webhook)

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = 256 * 1024; // 256 KB — o MVP manda só prompt + mensagens curtas
const LIVE_MODELO = process.env.GEMINI_LIVE_MODEL || 'gemini-3.8-live';
const LIVE_VOZ = process.env.GEMINI_LIVE_VOZ || 'Aoede';
const LIVE_TOKEN_URL = 'https://generativelanguage.googleapis.com/v1beta/auth_tokens';
// Token efêmero: 1 uso, expira em 30 min, só aceita abrir sessão nos 60 s
// seguintes. Limite antiabuso no endpoint: 10 tokens por IP a cada 5 min.
const LIVE_LIMITE_JANELA_MS = 5 * 60 * 1000;
const LIVE_LIMITE_MAX = 10;
const tokensPorIp = new Map(); // ip -> [timestamps]

// ------------------------------------------------------------------ Voz neural
// Edge TTS da Microsoft (grátis, sem chave). Só existem 3 vozes pt-BR, para
// 4 personagens: o Curioso usa a mesma base do Pensador (AntonioNeural),
// mas bem mais rápido e agudo (+25%, +6st) — na prática soa como outra
// pessoa (o teste local deu 3,06 s contra 4,02 s do Pensador, mesmo texto).
// "tom" ajusta o ritmo: pergunta +10 pontos, resposta -5 pontos.
const TTS_VOZES = {
  professora: { voz: 'pt-BR-FranciscaNeural', rate: '+0%', pitch: '+0st' },
  pensador:   { voz: 'pt-BR-AntonioNeural',   rate: '+0%', pitch: '+0st' },
  anotador:   { voz: 'pt-BR-ThalitaMultilingualNeural', rate: '+0%', pitch: '+0st' },
  curioso:    { voz: 'pt-BR-AntonioNeural',   rate: '+12%', pitch: '+3st' },
};
const TTS_VOZES_PERMITIDAS = Object.keys(TTS_VOZES).map((k) => TTS_VOZES[k].voz);
const TTS_LIMITE_JANELA_MS = 5 * 60 * 1000;
const TTS_LIMITE_MAX = 60; // 60 falas por IP a cada 5 min (uma conversa usa ~20-40)
const ttsPorIp = new Map(); // ip -> [timestamps]

function podeSintetizar(ip) {
  var agora = Date.now();
  var lista = (ttsPorIp.get(ip) || []).filter((t) => agora - t < TTS_LIMITE_JANELA_MS);
  if (lista.length >= TTS_LIMITE_MAX) return false;
  lista.push(agora);
  ttsPorIp.set(ip, lista);
  return true;
}

// Soma pontos percentuais a um rate do tipo "+25%" ou "-5%".
function ajustarRate(base, delta) {
  var n = parseInt(String(base).replace('%', ''), 10) || 0;
  n = Math.max(-20, Math.min(40, n + delta));
  return (n >= 0 ? '+' : '') + n + '%';
}

const PROVIDERS = {
  maritaca: {
    tipo: 'openai',
    endpoint: 'https://chat.maritaca.ai/api/chat/completions',
    modelo: process.env.MARITACA_MODEL || 'sabia-4-thinking',
    chave: () => process.env.MARITACA_API_KEY || '',
  },
  deepseek: {
    tipo: 'openai',
    endpoint: 'https://api.deepseek.com/chat/completions',
    modelo: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    chave: () => process.env.DEEPSEEK_API_KEY || '',
  },
  gemini: {
    tipo: 'gemini',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/models/' +
      (process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite') + ':generateContent',
    modelo: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
    chave: () => process.env.GEMINI_API_KEY || '',
  },
};

// Origens liberadas no CORS. localhost/127.0.0.1 em qualquer porta (teste
// local) + o GitHub Pages da Brittech Educação. Para liberar outro domínio,
// acrescente a origem exata em ALLOWED_ORIGINS (separada por vírgula).
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ||
  'https://thiagollipe-web.github.io')
  .split(',').map((s) => s.trim()).filter(Boolean);

function origemLiberada(origin) {
  if (!origin) return true; // curl / testes sem Origin passam
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) return true;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  return false;
}

function log(linha) {
  // Log mínimo: sem chave, sem conteúdo de mensagens, sem prompt.
  console.log(new Date().toISOString() + ' ' + linha);
}

// (postJson, erroSeguro e chamarProvedorOpenAI vivem em ia.js — usados
// aqui e pelo bot do Telegram.)

function responder(res, status, obj, origin) {
  const corpo = JSON.stringify(obj);
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(corpo),
  };
  if (origin && origemLiberada(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(corpo);
}

// Resposta binária (áudio MP3 do /api/tts) com os mesmos cabeçalhos CORS.
function responderBinario(res, status, buffer, contentType, origin) {
  const headers = {
    'Content-Type': contentType,
    'Content-Length': buffer.length,
  };
  if (origin && origemLiberada(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(buffer);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('corpo_muito_grande'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    req.on('error', reject);
  });
}

async function tratarChat(req, res, origin) {
  let corpo;
  try {
    corpo = JSON.parse(await lerCorpo(req));
  } catch (e) {
    if (e.message === 'corpo_muito_grande') {
      return responder(res, 413, { erro: 'Corpo da requisição muito grande (limite de 256 KB).' }, origin);
    }
    return responder(res, 400, { erro: 'Corpo da requisição não é um JSON válido.' }, origin);
  }

  const provider = corpo.provider;
  const messages = corpo.messages;
  if (!PROVIDERS[provider]) {
    return responder(res, 400, { erro: 'Provedor inválido. Use "maritaca", "deepseek" ou "gemini".' }, origin);
  }
  if (!Array.isArray(messages) || messages.length === 0 ||
      messages.some((m) => !m || typeof m.role !== 'string' || typeof m.content !== 'string')) {
    return responder(res, 400, { erro: 'Campo "messages" deve ser um array não vazio de {role, content}.' }, origin);
  }

  const prov = PROVIDERS[provider];
  const chave = prov.chave();
  if (!chave) {
    log(provider + ' -> 500 chave ausente no servidor');
    return responder(res, 500, {
      erro: 'Chave da API do provedor "' + provider + '" não configurada no servidor. ' +
        'Configure a variável de ambiente ' + provider.toUpperCase() + '_API_KEY no proxy e reinicie.',
    }, origin);
  }

  const temperature = typeof corpo.temperature === 'number' ? corpo.temperature : 0.7;
  const maxTokens = typeof corpo.max_tokens === 'number' ? corpo.max_tokens : 3000;

  try {
    if (prov.tipo === 'gemini') {
      const textoPrompt = messages.map((m) => m.content).join('\n\n');
      const r = await postJson(prov.endpoint + '?key=' + encodeURIComponent(chave), {},
        { contents: [{ parts: [{ text: textoPrompt }] }] });
      if (r.status < 200 || r.status >= 300) {
        log(provider + ' -> ' + r.status + ' (erro da API do Gemini)');
        return responder(res, 502, { erro: 'A API do Gemini respondeu HTTP ' + r.status + '.', detalhe: erroSeguro(r.texto) }, origin);
      }
      const json = JSON.parse(r.texto);
      const texto = json && json.candidates && json.candidates[0] && json.candidates[0].content &&
        json.candidates[0].content.parts &&
        json.candidates[0].content.parts.map((p) => p.text || '').join('\n');
      if (!texto) return responder(res, 502, { erro: 'A API do Gemini devolveu uma resposta vazia.' }, origin);
      log(provider + ' -> 200 ok');
      return responder(res, 200, { provider, modelo: prov.modelo, text: texto }, origin);
    }

    // Maritaca e DeepSeek: formato compatível com OpenAI (chamada interna
    // em ia.js — a mesma que o bot do Telegram usa).
    try {
      const out = await chamarProvedorOpenAI(
        { endpoint: prov.endpoint, modelo: prov.modelo, chave },
        messages, temperature, maxTokens);
      log(provider + ' -> 200 ok');
      return responder(res, 200, {
        provider, modelo: prov.modelo, text: out.text,
        uso: out.uso || undefined,
      }, origin);
    } catch (e) {
      if (e.codigo === 'api') {
        log(provider + ' -> ' + (e.status || 'erro') + ' (erro da API)');
        return responder(res, 502, { erro: e.message, detalhe: e.detalhe }, origin);
      }
      throw e; // erro de rede — cai no catch externo, que devolve 502
    }
  } catch (e) {
    log(provider + ' -> 502 erro de rede: ' + e.message);
    return responder(res, 502, { erro: 'Não foi possível falar com a API do provedor (' + e.message + ').' }, origin);
  }
}

// ------------------------------------------------------------------ Live API
// Instrução do professor da conversa ao vivo. O tema e o conteúdo da aula
// entram aqui (a chave e a instrução ficam no servidor; o navegador recebe
// só o token efêmero, travado a este modelo e a esta configuração).
function instrucaoProfessor(tema, conteudo, nomeAluno) {
  var nome = nomeAluno ? ' O aluno se chama ' + nomeAluno + '.' : '';
  var base = conteudo
    ? ' Use SÓ este conteúdo como base da aula: ' + conteudo
    : ' Use só o tema como base; não invente dados, datas ou exemplos fora dele.';
  return 'Você é o Professor da Brittech Educação, professor de Tecnologia e ' +
    'Língua Portuguesa para alunos do ensino fundamental e médio. Fale sempre ' +
    'em português brasileiro, com frases curtas e linguagem simples.' + nome +
    ' Tema da aula: ' + tema + '.' + base + ' Nunca invente dados, datas ou ' +
    'exemplos; se não souber algo, diga que não sabe e sugira onde procurar. ' +
    'Faça perguntas curtas ao aluno durante a aula e espere a resposta; ' +
    'corrija com gentileza, elogiando o acerto antes de corrigir o erro. ' +
    'Na sala também estão os colegas Curioso (pergunta muito), Anotador ' +
    '(resume os pontos principais) e Pensador (reflete e relaciona com o dia ' +
    'a dia) — quando um deles falar, responda a ele pelo nome e depois volte ' +
    'a atenção ao aluno. Comece se apresentando e perguntando ao aluno o que ' +
    'ele já sabe sobre o tema.';
}

// Antiabuso simples: no máximo LIVE_LIMITE_MAX tokens por IP na janela.
function podeGerarToken(ip) {
  var agora = Date.now();
  var lista = (tokensPorIp.get(ip) || []).filter((t) => agora - t < LIVE_LIMITE_JANELA_MS);
  if (lista.length >= LIVE_LIMITE_MAX) return false;
  lista.push(agora);
  tokensPorIp.set(ip, lista);
  return true;
}

// POST /api/live-token { tema, conteudo?, nomeAluno? }
// Gera um token efêmero da Gemini Live API (1 uso, 30 min) com a chave
// GEMINI_API_KEY do servidor. O navegador usa o token para abrir o
// WebSocket direto com o Google — a chave NUNCA sai do servidor.
async function tratarLiveToken(req, res, origin) {
  let corpo;
  try {
    corpo = JSON.parse(await lerCorpo(req));
  } catch (e) {
    if (e.message === 'corpo_muito_grande') {
      return responder(res, 413, { erro: 'Corpo da requisição muito grande (limite de 256 KB).' }, origin);
    }
    return responder(res, 400, { erro: 'Corpo da requisição não é um JSON válido.' }, origin);
  }
  const tema = typeof corpo.tema === 'string' ? corpo.tema.trim() : '';
  const conteudo = typeof corpo.conteudo === 'string' ? corpo.conteudo.trim() : '';
  const nomeAluno = typeof corpo.nomeAluno === 'string' ? corpo.nomeAluno.trim() : '';
  if (!tema || tema.length > 200) {
    return responder(res, 400, { erro: 'Informe o tema da aula (até 200 caracteres).' }, origin);
  }
  if (conteudo.length > 12000) {
    return responder(res, 400, { erro: 'O conteúdo da aula deve ter até 12.000 caracteres.' }, origin);
  }
  if (nomeAluno.length > 40) {
    return responder(res, 400, { erro: 'O nome do aluno deve ter até 40 caracteres.' }, origin);
  }
  const chave = process.env.GEMINI_API_KEY || '';
  if (!chave) {
    log('live-token -> 500 chave Gemini ausente no servidor');
    return responder(res, 500, {
      erro: 'Falta a chave Gemini no servidor. No painel do Render (brittech-proxy → ' +
        'Environment Variables), crie a variável GEMINI_API_KEY com a chave do Google AI ' +
        'Studio e reinicie o serviço. Sem ela, a conversa ao vivo não abre.',
    }, origin);
  }
  const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : (req.socket.remoteAddress || 'local');
  if (!podeGerarToken(ip)) {
    log('live-token -> 429 limite por IP');
    return responder(res, 429, { erro: 'Muitos pedidos de token em pouco tempo. Aguarde alguns minutos e tente de novo.' }, origin);
  }
  const agora = new Date();
  const expira = new Date(agora.getTime() + 30 * 60 * 1000).toISOString();
  const expiraSessao = new Date(agora.getTime() + 60 * 1000).toISOString();
  const instrucao = instrucaoProfessor(tema, conteudo, nomeAluno);
  const corpoToken = {
    uses: 1,
    expireTime: expira,
    newSessionExpireTime: expiraSessao,
    liveConnectConstraints: {
      model: LIVE_MODELO,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: LIVE_VOZ } } },
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        systemInstruction: { parts: [{ text: instrucao }] },
      },
    },
  };
  try {
    const r = await postJson(LIVE_TOKEN_URL, { 'x-goog-api-key': chave }, corpoToken);
    if (r.status < 200 || r.status >= 300) {
      log('live-token -> ' + r.status + ' (erro do Google ao gerar o token)');
      return responder(res, 502, { erro: 'O Google respondeu HTTP ' + r.status + ' ao gerar o token da conversa.', detalhe: erroSeguro(r.texto) }, origin);
    }
    const json = JSON.parse(r.texto);
    if (!json || typeof json.name !== 'string' || json.name.indexOf('auth_tokens/') !== 0) {
      log('live-token -> 502 resposta inesperada do Google');
      return responder(res, 502, { erro: 'O Google devolveu uma resposta inesperada ao gerar o token.' }, origin);
    }
    log('live-token -> 200 ok (modelo ' + LIVE_MODELO + ')');
    // O token vai ao navegador; ele expira em 30 min e só serve para 1 sessão.
    return responder(res, 200, {
      token: json.name,
      modelo: LIVE_MODELO,
      vozProfessor: LIVE_VOZ,
      expiraEmSegundos: 1800,
    }, origin);
  } catch (e) {
    log('live-token -> 502 erro de rede: ' + e.message);
    return responder(res, 502, { erro: 'Não foi possível falar com o Google para gerar o token (' + e.message + ').' }, origin);
  }
}

// (erroSeguro vive em ia.js — usado pelo /api/chat e pelo /api/live-token.)

// ------------------------------------------------------------------ Voz neural
// POST /api/tts { texto, personagem?, voz?, tom? }
// Gera o áudio da fala com as vozes neurais brasileiras do Edge TTS
// (Microsoft, grátis, sem chave). Devolve o MP3.
//   personagem: "professora" | "curioso" | "anotador" | "pensador"
//   voz: em vez de personagem, o nome exato de uma das 3 vozes permitidas
//   tom: "pergunta" (mais rápido) | "resposta" (mais calmo) | "normal"
// Texto de 1 a 2000 caracteres. Sem a voz ou com texto vazio: erro em pt-BR.
async function tratarTts(req, res, origin) {
  let corpo;
  try {
    corpo = JSON.parse(await lerCorpo(req));
  } catch (e) {
    if (e.message === 'corpo_muito_grande') {
      return responder(res, 413, { erro: 'Corpo da requisição muito grande (limite de 256 KB).' }, origin);
    }
    return responder(res, 400, { erro: 'Corpo da requisição não é um JSON válido.' }, origin);
  }
  const texto = typeof corpo.texto === 'string' ? corpo.texto.trim() : '';
  if (!texto || texto.length > 2000) {
    return responder(res, 400, { erro: 'Informe o texto da fala (de 1 a 2000 caracteres).' }, origin);
  }
  const tom = corpo.tom === 'pergunta' ? 'pergunta' : (corpo.tom === 'resposta' ? 'resposta' : 'normal');
  let cfg = null;
  // "professor" é aceito como apelido de "professora" (é o nome que a
  // página usa internamente para o personagem).
  const personagem = corpo.personagem === 'professor' ? 'professora' : corpo.personagem;
  if (typeof personagem === 'string' && TTS_VOZES[personagem]) {
    cfg = TTS_VOZES[personagem];
  } else if (typeof corpo.voz === 'string' && TTS_VOZES_PERMITIDAS.indexOf(corpo.voz) !== -1) {
    cfg = { voz: corpo.voz, rate: '+0%', pitch: '+0st' };
  }
  if (!cfg) {
    return responder(res, 400, {
      erro: 'Informe o personagem ("professora", "curioso", "anotador" ou "pensador") ou uma das vozes permitidas: ' +
        TTS_VOZES_PERMITIDAS.filter((v, i, a) => a.indexOf(v) === i).join(', ') + '.',
    }, origin);
  }
  const ip = req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : (req.socket.remoteAddress || 'local');
  if (!podeSintetizar(ip)) {
    log('tts -> 429 limite por IP');
    return responder(res, 429, { erro: 'Muitas falas em pouco tempo. Aguarde alguns minutos e tente de novo.' }, origin);
  }
  const delta = tom === 'pergunta' ? 10 : (tom === 'resposta' ? -5 : 0);
  const rate = ajustarRate(cfg.rate, delta);
  const t0 = Date.now();
  try {
    const audio = await sintetizar({ voz: cfg.voz, texto: texto, rate: rate, pitch: cfg.pitch });
    log('tts -> 200 ok (' + cfg.voz + ' ' + rate + ' ' + cfg.pitch + ', ' + audio.length + ' bytes, ' + (Date.now() - t0) + ' ms)');
    return responderBinario(res, 200, audio, 'audio/mpeg', origin);
  } catch (e) {
    log('tts -> 502 erro da voz neural: ' + e.message);
    return responder(res, 502, { erro: 'Não consegui gerar o áudio da voz neural: ' + e.message + ' Tente de novo — se persistir, a página usa a voz do aparelho.' }, origin);
  }
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || '';

  // Preflight CORS.
  if (req.method === 'OPTIONS') {
    const headers = { 'Content-Length': '0' };
    if (origemLiberada(origin)) {
      headers['Access-Control-Allow-Origin'] = origin;
      headers['Access-Control-Allow-Methods'] = 'POST, GET, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type';
      headers['Access-Control-Max-Age'] = '86400';
      headers['Vary'] = 'Origin';
    }
    res.writeHead(204, headers);
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'GET' && url.pathname === '/health') {
    return responder(res, 200, {
      ok: true,
      provedores: Object.keys(PROVIDERS),
      chavesConfiguradas: Object.keys(PROVIDERS).filter((p) => !!PROVIDERS[p].chave()),
      live: {
        modelo: LIVE_MODELO,
        vozProfessor: LIVE_VOZ,
        chaveGeminiConfigurada: !!(process.env.GEMINI_API_KEY || ''),
        endpointToken: 'POST /api/live-token',
      },
      tts: {
        endpoint: 'POST /api/tts',
        vozes: TTS_VOZES_PERMITIDAS.filter((v, i, a) => a.indexOf(v) === i),
        personagens: Object.keys(TTS_VOZES),
      },
      telegram: {
        endpoint: 'POST /api/telegram',
        botConfigurado: telegram.botAtivo(),
        limitesDiariosPorUsuario: { planos: telegram.LIMITE_PLANOS_DIA, mensagens: telegram.LIMITE_MSGS_DIA },
      },
    }, origin);
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (origin && !origemLiberada(origin)) {
      return responder(res, 403, { erro: 'Origem não liberada neste proxy.' }, origin);
    }
    return tratarChat(req, res, origin);
  }
  if (req.method === 'POST' && url.pathname === '/api/live-token') {
    if (origin && !origemLiberada(origin)) {
      return responder(res, 403, { erro: 'Origem não liberada neste proxy.' }, origin);
    }
    return tratarLiveToken(req, res, origin);
  }
  if (req.method === 'POST' && url.pathname === '/api/tts') {
    if (origin && !origemLiberada(origin)) {
      return responder(res, 403, { erro: 'Origem não liberada neste proxy.' }, origin);
    }
    return tratarTts(req, res, origin);
  }
  if (req.method === 'POST' && url.pathname === '/api/telegram') {
    // Webhook do Telegram: chamada servidor-para-servidor, sem CORS.
    // Sem TELEGRAM_BOT_TOKEN o bot fica inerte (responde 200 e ignora).
    return telegram.tratarWebhook(req, res);
  }
  return responder(res, 404, { erro: 'Rota não encontrada. Use POST /api/chat, POST /api/live-token, POST /api/tts, POST /api/telegram ou GET /health.' }, origin);
});

server.listen(PORT, () => {
  log('proxy da Brittech Educação ouvindo na porta ' + PORT);
  log('provedores: ' + Object.keys(PROVIDERS).join(', ') +
    ' | chaves configuradas: ' + (Object.keys(PROVIDERS).filter((p) => !!PROVIDERS[p].chave()).join(', ') || 'nenhuma'));
  // Bot do Telegram: com TELEGRAM_BOT_TOKEN configurado, registra o
  // webhook sozinho; sem o token, o bot fica inerte e nada muda.
  telegram.registrarWebhook().catch((e) => log('telegram: erro ao registrar webhook: ' + e.message));
});
