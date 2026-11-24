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
//   GEMINI_API_KEY     chave do Gemini  (provedor "gemini")
//   MARITACA_MODEL     modelo da Maritaca (padrão: sabia-4-thinking)
//   DEEPSEEK_MODEL     modelo da DeepSeek (padrão: deepseek-chat)
//   GEMINI_MODEL       modelo do Gemini  (padrão: gemini-2.5-flash-lite)
//   ALLOWED_ORIGINS    origens liberadas no CORS, separadas por vírgula
//                      (padrão: http://localhost:*, http://127.0.0.1:* e
//                      https://thiagollipe-web.github.io)
// NUNCA coloque uma chave neste arquivo nem em nenhum arquivo do repositório.

'use strict';

const http = require('http');
const https = require('https');

const PORT = Number(process.env.PORT || 8787);
const MAX_BODY_BYTES = 256 * 1024; // 256 KB — o MVP manda só prompt + mensagens curtas

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

// POST JSON para uma URL https. Devolve { status, texto }.
function postJson(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const dados = JSON.stringify(bodyObj);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dados),
      }, headers),
    }, (resp) => {
      let corpo = '';
      resp.on('data', (c) => { corpo += c; });
      resp.on('end', () => resolve({ status: resp.statusCode, texto: corpo }));
    });
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
}

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

    // Maritaca e DeepSeek: formato compatível com OpenAI.
    const r = await postJson(prov.endpoint,
      { Authorization: 'Bearer ' + chave },
      { model: prov.modelo, messages, temperature, max_tokens: maxTokens });
    if (r.status < 200 || r.status >= 300) {
      log(provider + ' -> ' + r.status + ' (erro da API)');
      return responder(res, 502, { erro: 'A API respondeu HTTP ' + r.status + '.', detalhe: erroSeguro(r.texto) }, origin);
    }
    const json = JSON.parse(r.texto);
    const texto = json && json.choices && json.choices[0] && json.choices[0].message &&
      json.choices[0].message.content;
    if (!texto) return responder(res, 502, { erro: 'A API devolveu uma resposta vazia.' }, origin);
    log(provider + ' -> 200 ok');
    return responder(res, 200, {
      provider, modelo: prov.modelo, text: texto,
      uso: json.usage || undefined,
    }, origin);
  } catch (e) {
    log(provider + ' -> 502 erro de rede: ' + e.message);
    return responder(res, 502, { erro: 'Não foi possível falar com a API do provedor (' + e.message + ').' }, origin);
  }
}

// Extrai uma mensagem de erro curta da resposta da API, sem vazar chaves.
function erroSeguro(texto) {
  try {
    const j = JSON.parse(texto);
    const msg = (j.error && (j.error.message || j.error)) || j.message || j.detail;
    if (typeof msg === 'string' && msg.length > 0) return msg.slice(0, 300);
  } catch (e) { /* não é JSON — ignora */ }
  return undefined;
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
    }, origin);
  }
  if (req.method === 'POST' && url.pathname === '/api/chat') {
    if (origin && !origemLiberada(origin)) {
      return responder(res, 403, { erro: 'Origem não liberada neste proxy.' }, origin);
    }
    return tratarChat(req, res, origin);
  }
  return responder(res, 404, { erro: 'Rota não encontrada. Use POST /api/chat ou GET /health.' }, origin);
});

server.listen(PORT, () => {
  log('proxy da Brittech Educação ouvindo na porta ' + PORT);
  log('provedores: ' + Object.keys(PROVIDERS).join(', ') +
    ' | chaves configuradas: ' + (Object.keys(PROVIDERS).filter((p) => !!PROVIDERS[p].chave()).join(', ') || 'nenhuma'));
});
