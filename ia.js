// Brittech Educação — chamadas à IA (módulo interno do proxy).
// Usado por POST /api/chat (server.js) e pelo bot do Telegram
// (telegram.js). Antes estas funções viviam dentro de server.js; foram
// extraídas para cá para que o bot chame a IA pela função interna —
// nunca por HTTP para o próprio serviço.
//
// Só biblioteca padrão do Node.js — nada para instalar.
// NUNCA coloque uma chave aqui: as chaves vêm de variáveis de ambiente,
// lidas na hora da chamada.
'use strict';

const https = require('https');

// POST JSON para uma URL https. Devolve { status, texto }.
// Timeout de 20 s: sem ele, uma API lenta deixaria a requisição pendurada
// para sempre (e, no webhook do Telegram, seguraria a resposta).
function postJson(url, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const dados = JSON.stringify(bodyObj);
    const req = https.request({
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method: 'POST',
      timeout: 20000,
      headers: Object.assign({
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dados),
      }, headers),
    }, (resp) => {
      let corpo = '';
      resp.on('data', (c) => { corpo += c; });
      resp.on('end', () => resolve({ status: resp.statusCode, texto: corpo }));
    });
    req.on('timeout', () => {
      req.destroy(new Error('Tempo esgotado ao falar com a API (20 s).'));
    });
    req.on('error', reject);
    req.write(dados);
    req.end();
  });
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

// Chama um provedor no formato compatível com OpenAI (Maritaca, DeepSeek).
//   prov: { endpoint, modelo, chave } — chave já lida do env por quem chama.
// Devolve { text, uso }.
// Lança Error em caso de falha:
//   - erro da API (HTTP fora de 2xx, resposta vazia ou inválida):
//     err.codigo === 'api', err.status, err.detalhe (mensagem curta, sem chave).
//   - erro de rede: Error comum (sem .codigo), tratado por quem chama.
async function chamarProvedorOpenAI(prov, messages, temperature, maxTokens) {
  const r = await postJson(prov.endpoint,
    { Authorization: 'Bearer ' + prov.chave },
    { model: prov.modelo, messages, temperature, max_tokens: maxTokens });
  if (r.status < 200 || r.status >= 300) {
    const err = new Error('A API respondeu HTTP ' + r.status + '.');
    err.codigo = 'api';
    err.status = r.status;
    err.detalhe = erroSeguro(r.texto);
    throw err;
  }
  let json;
  try {
    json = JSON.parse(r.texto);
  } catch (e) {
    const err = new Error('A API devolveu uma resposta inválida.');
    err.codigo = 'api';
    err.status = r.status;
    throw err;
  }
  const texto = json && json.choices && json.choices[0] && json.choices[0].message &&
    json.choices[0].message.content;
  if (!texto) {
    const err = new Error('A API devolveu uma resposta vazia.');
    err.codigo = 'api';
    err.status = r.status;
    throw err;
  }
  return { text: texto, uso: json.usage || undefined };
}

module.exports = { postJson, erroSeguro, chamarProvedorOpenAI };
