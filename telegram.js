// Brittech Educação — Brito no Telegram (telegram.js)
// Bot do Telegram que leva o agente Brito para dentro do Telegram, usando
// a MESMA IA real do MVP (Maritaca sabia-4-thinking, via proxy) e os
// MESMOS prompts e persona do agente do MVP:
//   - persona do Brito: mvp/app.js (BRITO.saudacao — "Oi, eu sou o Brito!")
//   - prompt do plano:  mvp/app.js (PROMPT_SISTEMA_PLANO)
//   - prompt e tipos de documento: mvp/agente.js (PROMPT_SISTEMA_AGENTE,
//     TIPOS_DOC, gerarDocumentoComIA)
//
// COMO FUNCIONA
// O Telegram entrega cada mensagem do usuário como um "update" no webhook
// POST /api/telegram (server.js). Este módulo interpreta o update, chama
// a IA pela função interna (ia.js — nunca por HTTP para o próprio
// serviço) e devolve a resposta com sendMessage da Bot API.
//
// SEGURANÇA
// - O token do bot vem SÓ de process.env.TELEGRAM_BOT_TOKEN — nunca está
//   neste arquivo, nunca vai para log e nunca aparece em mensagem de erro.
// - A chave da Maritaca também só vive em variável de ambiente e nunca
//   sai do servidor (a chamada à Maritaca é feita aqui dentro, no proxy).
// - O token nunca é registrado em log: os logs mostram só o nome do
//   método da Bot API e o status, nunca a URL (que contém o token).
//
// CUSTO (Maritaca é paga por token, ~R$ 0,13 por plano)
// Limite por usuário (chat do Telegram), em memória, sem banco de dados:
//   - 5 planos/documentos por dia e 30 mensagens por dia, por usuário.
//   - /start e /ajuda não gastam nada (não chamam a IA).
//   - /plano e /documento gastam 1 plano E 1 mensagem.
//   - O contador zera à meia-noite (data UTC do servidor) e quando o
//     serviço reinicia (o plano gratuito do Render dorme e reinicia —
//     na prática, o limite vale por dia E por ciclo de vida do serviço).
//   - Ajuste com TELEGRAM_LIMITE_PLANOS_DIA e TELEGRAM_LIMITE_MSGS_DIA.
//
// LIMITES DO TELEGRAM
// - Mensagem de texto: no máximo 4096 caracteres — respostas maiores são
//   divididas em várias mensagens (dividirTexto).
// - Planilhas (.xlsx) ficam para a v2: /documento entrega só texto.
// - O fluxo de perguntas do MVP (até 2 rodadas pedindo o que falta)
//   ainda não existe aqui: no /documento, os dados vão junto no comando
//   (ex.: /documento ata 25/11/2026, 6º ano B, reunião de pais) e o que
//   não for informado vira "a preencher" — a mesma regra do agente.js.
//
// Só biblioteca padrão do Node.js — nada para instalar.
'use strict';

const { postJson, chamarProvedorOpenAI } = require('./ia');

// ---------------------------------------------------------- Configuração
// Tudo por variável de ambiente; o token é lido na hora da chamada (não
// na carga do módulo) para que os testes possam ligá-lo depois de subir
// o servidor — e para que o bot fique inerte sem ele.
function botToken() { return process.env.TELEGRAM_BOT_TOKEN || ''; }
function webhookUrl() {
  return process.env.TELEGRAM_WEBHOOK_URL || 'https://brittech-proxy.onrender.com/api/telegram';
}
function webhookSecret() { return process.env.TELEGRAM_WEBHOOK_SECRET || ''; }
function registroAutomatico() { return process.env.TELEGRAM_AUTO_REGISTRO !== '0'; }
function botAtivo() { return !!botToken(); }

const LIMITE_PLANOS_DIA = Number(process.env.TELEGRAM_LIMITE_PLANOS_DIA || 5);
const LIMITE_MSGS_DIA = Number(process.env.TELEGRAM_LIMITE_MSGS_DIA || 30);
const LIMITE_MSG_TELEGRAM = 4096; // teto da Bot API por mensagem de texto
const MAX_CORPO_WEBHOOK_BYTES = 256 * 1024;

// Tokens máximos por chamada (a Maritaca sabia-4-thinking gasta parte em
// raciocínio — os mesmos valores do MVP: plano 3000, documento 2000).
const MAX_TOKENS_PLANO = 3000;
const MAX_TOKENS_DOCUMENTO = 2000;
const MAX_TOKENS_CHAT = 1000;

// ---------------------------------------------------------- Log mínimo
// Sem token, sem chave, sem conteúdo de mensagens dos usuários.
function log(linha) {
  console.log(new Date().toISOString() + ' telegram: ' + linha);
}
let avisoInerteJaMostrado = false;
function logInerteUmaVez() {
  if (avisoInerteJaMostrado) return;
  avisoInerteJaMostrado = true;
  log('sem TELEGRAM_BOT_TOKEN — bot inerte (o resto do proxy continua normal)');
}

// ---------------------------------------------------------- Limite diário
// chatId -> { dia: 'AAAA-MM-DD' (UTC), planos: n, mensagens: n }
const usoPorChat = new Map();

function diaHoje() {
  return new Date().toISOString().slice(0, 10);
}
function usoDoChat(chatId) {
  const hoje = diaHoje();
  let uso = usoPorChat.get(chatId);
  if (!uso || uso.dia !== hoje) {
    uso = { dia: hoje, planos: 0, mensagens: 0 };
    usoPorChat.set(chatId, uso);
    // Guarda simples contra crescimento sem fim do mapa em memória.
    if (usoPorChat.size > 10000) usoPorChat.clear();
  }
  return uso;
}
// tipo: 'plano' (gasta 1 plano + 1 mensagem) ou 'mensagem' (gasta 1).
// Devolve { ok: true } ou { ok: false, motivo: 'planos' | 'mensagens' }.
function podeUsar(chatId, tipo) {
  const uso = usoDoChat(chatId);
  if (tipo === 'plano' && uso.planos >= LIMITE_PLANOS_DIA) {
    return { ok: false, motivo: 'planos' };
  }
  if (uso.mensagens >= LIMITE_MSGS_DIA) {
    return { ok: false, motivo: 'mensagens' };
  }
  return { ok: true };
}
function registrarUso(chatId, tipo) {
  const uso = usoDoChat(chatId);
  if (tipo === 'plano') uso.planos += 1;
  uso.mensagens += 1;
}
function textoLimite(motivo) {
  if (motivo === 'planos') {
    return 'Você atingiu o limite de hoje (' + LIMITE_PLANOS_DIA + ' planos/documentos por dia). ' +
      'Volte amanhã — o limite renova todo dia. Se precisar de mais, use o planejador no site: https://thiagollipe-web.github.io/brittech-educacao-mvp/';
  }
  return 'Você atingiu o limite de hoje (' + LIMITE_MSGS_DIA + ' mensagens por dia). ' +
    'Volte amanhã — o limite renova todo dia.';
}

// ---------------------------------------------------------- Bot API
function urlBot(metodo) {
  return 'https://api.telegram.org/bot' + botToken() + '/' + metodo;
}
// Chama um método da Bot API. Devolve o JSON decodificado ou null quando
// a API responde erro (o erro vai só para o log do servidor, sem token).
async function chamarTelegram(metodo, corpo) {
  let r;
  try {
    r = await postJson(urlBot(metodo), {}, corpo);
  } catch (e) {
    log(metodo + ' -> erro de rede: ' + e.message);
    return null;
  }
  if (r.status < 200 || r.status >= 300) {
    log(metodo + ' -> HTTP ' + r.status + ' (a API do Telegram recusou)');
    return null;
  }
  try {
    return JSON.parse(r.texto);
  } catch (e) {
    log(metodo + ' -> resposta inválida da API do Telegram');
    return null;
  }
}

// Divide um texto longo em partes de até 4096 caracteres, de preferência
// na quebra de parágrafo, depois na quebra de linha, e só por último no
// meio de uma palavra. A junção das partes com '\n' devolve o original.
function dividirTexto(texto, limite) {
  const max = limite || LIMITE_MSG_TELEGRAM;
  const partes = [];
  let resto = String(texto || '');
  while (resto.length > max) {
    let corte = -1;
    const quebraDupla = resto.lastIndexOf('\n\n', max);
    const quebraSimples = resto.lastIndexOf('\n', max);
    const espaco = resto.lastIndexOf(' ', max);
    if (quebraDupla > max * 0.5) corte = quebraDupla + 2;
    else if (quebraSimples > max * 0.5) corte = quebraSimples + 1;
    else if (espaco > max * 0.5) corte = espaco + 1;
    else corte = max;
    partes.push(resto.slice(0, corte));
    resto = resto.slice(corte);
  }
  if (resto.length > 0) partes.push(resto);
  return partes;
}

async function enviarMensagem(chatId, texto) {
  if (!botAtivo()) return false;
  const partes = dividirTexto(texto);
  for (const parte of partes) {
    const r = await chamarTelegram('sendMessage', { chat_id: chatId, text: parte });
    if (!r || r.ok === false) return false;
  }
  return true;
}

async function enviarAcao(chatId, acao) {
  if (!botAtivo()) return;
  await chamarTelegram('sendChatAction', { chat_id: chatId, action: acao });
}

// ---------------------------------------------------------- Prompts do Brito
// Textos copiados do MVP (mesma persona, mesmos prompts) — ver os
// comentários no topo do arquivo. Só o formato da resposta muda: no
// Telegram a IA responde em texto puro (sem HTML, sem markdown), porque
// o Telegram não renderiza HTML e o markdown da IA costuma vir quebrado.
const PROMPT_SISTEMA_PLANO =
  'Você é um assistente de planejamento escolar brasileiro. Escreva planos de aula completos e práticos, em português, alinhados à BNCC, adequados à realidade da escola pública brasileira. Não invente outra habilidade BNCC além da informada.';
const PROMPT_SISTEMA_AGENTE =
  'Você é um assistente de documentação escolar brasileiro. Escreva documentos e planilhas práticos, em português, adequados à realidade da escola pública brasileira. Não invente nomes de alunos, datas, números nem fatos — use só os dados informados; o que não foi informado, deixe em branco ou como "a preencher". Responda sempre em português.';
const PROMPT_SISTEMA_CHAT =
  'Você é o Brito, o assistente da Brittech Educação. Fale sempre em português brasileiro, direto e prático, professor para professor, com frases curtas. ' +
  'Você ajuda com planos de aula, documentos escolares e dúvidas de sala de aula. Não invente dados, datas ou fatos; se não souber algo, diga que não sabe e sugira onde procurar. ' +
  'Responda em texto puro (sem HTML, sem markdown), em no máximo 6 frases curtas, salvo se o professor pedir algo maior. ' +
  'Se o professor pedir um plano de aula, sugira o comando /plano; se pedir um documento (ata, relatório, parecer...), sugira /documento.';

// Os 8 documentos do agente do MVP (mvp/agente.js — TIPOS_DOC).
const TIPOS_DOC = {
  'ata': { nome: 'ata de reunião' },
  'relatorio': { nome: 'relatório de turma' },
  'parecer': { nome: 'parecer descritivo' },
  'ficha': { nome: 'ficha de avaliação' },
  'planejamento-anual': { nome: 'planejamento anual' },
  'sequencia': { nome: 'sequência didática' },
  'comunicado': { nome: 'comunicado aos pais' },
  'lista-chamada': { nome: 'lista de chamada' },
};
const APELIDOS_DOC = {
  'ata': 'ata',
  'relatorio': 'relatorio', 'relatório': 'relatorio',
  'parecer': 'parecer',
  'ficha': 'ficha',
  'planejamento anual': 'planejamento-anual', 'planejamento-anual': 'planejamento-anual', 'plano anual': 'planejamento-anual',
  'sequencia': 'sequencia', 'sequência': 'sequencia', 'sequencia didatica': 'sequencia', 'sequência didática': 'sequencia',
  'comunicado': 'comunicado',
  'lista de chamada': 'lista-chamada', 'lista-chamada': 'lista-chamada', 'lista de presenca': 'lista-chamada', 'chamada': 'lista-chamada',
};

function semAcento(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const TEXTO_START =
  'Oi, eu sou o Brito! Seu ajudante de planejamento da Brittech Educação.\n\n' +
  'Eu monto plano de aula com IA, escrevo documentos da escola e tiro dúvidas de sala de aula — tudo em português, direto e prático.\n\n' +
  'O que eu faço:\n' +
  '/plano EF06CI01 — plano de aula pela habilidade BNCC ou pelo tema\n' +
  '/documento ata — documentos da escola (ata, relatório, parecer e mais)\n' +
  'Ou só escreva sua dúvida.\n\n' +
  'Limite diário: ' + LIMITE_PLANOS_DIA + ' planos/documentos e ' + LIMITE_MSGS_DIA + ' mensagens por dia, para o custo da IA não estourar.\n\n' +
  'Digite /ajuda para ver todos os comandos.';

function textoAjuda() {
  const docs = Object.keys(TIPOS_DOC).map((k) => '  /documento ' + k).join('\n');
  return 'Comandos do Brito:\n\n' +
    '/plano <habilidade BNCC ou tema>\n' +
    '  Gera um plano de aula com IA.\n' +
    '  Ex.: /plano EF06CI01\n' +
    '  Ex.: /plano Misturas homogêneas e heterogêneas, 6º ano\n\n' +
    '/documento <tipo> <dados>\n' +
    '  Gera um documento da escola, em texto.\n' +
    '  Ex.: /documento ata 25/11/2026, 6º ano B, reunião de pais\n' +
    '  Ex.: /documento parecer Maria Silva, 7º ano C\n' +
    '  Tipos:\n' + docs + '\n\n' +
    'Sem comando, é só escrever: eu respondo como o Brito.\n\n' +
    'Limite diário: ' + LIMITE_PLANOS_DIA + ' planos/documentos e ' + LIMITE_MSGS_DIA + ' mensagens por dia.\n' +
    'Planilhas (.xlsx) chegam numa próxima versão — por aqui, só texto por enquanto.\n' +
    'Site da Brittech Educação: https://thiagollipe-web.github.io/brittech-educacao/';
}

// ---------------------------------------------------------- Interpretação
// Função pura (sem rede): dada a mensagem, diz o que o bot deve fazer.
// Devolve { acao, arg, tipoDoc } — acao é 'start', 'ajuda', 'plano',
// 'documento', 'chat' ou 'desconhecido'.
function interpretarMensagem(texto) {
  const msg = String(texto || '').trim();
  if (!msg) return { acao: 'desconhecido', arg: '', tipoDoc: null };
  const partes = msg.split(/\s+/);
  const cmd = partes[0].toLowerCase();
  const resto = msg.slice(partes[0].length).trim();
  if (cmd === '/start') return { acao: 'start', arg: '', tipoDoc: null };
  if (cmd === '/ajuda' || cmd === '/help') return { acao: 'ajuda', arg: '', tipoDoc: null };
  if (cmd === '/plano') return { acao: 'plano', arg: resto, tipoDoc: null };
  if (cmd === '/documento') {
    const restoSemAcento = semAcento(resto);
    // Casa o tipo pelo apelido mais longo primeiro ("lista de chamada"
    // antes de "chamada"; "planejamento anual" antes de "plano").
    const apelidos = Object.keys(APELIDOS_DOC).sort((a, b) => b.length - a.length);
    for (const ap of apelidos) {
      if (restoSemAcento === ap || restoSemAcento.indexOf(ap + ' ') === 0) {
        return { acao: 'documento', arg: resto.slice(ap.length).trim(), tipoDoc: APELIDOS_DOC[ap] };
      }
    }
    return { acao: 'documento', arg: resto, tipoDoc: null };
  }
  if (cmd.charAt(0) === '/') return { acao: 'desconhecido', arg: '', tipoDoc: null };
  return { acao: 'chat', arg: msg, tipoDoc: null };
}

// ---------------------------------------------------------- Montagem dos prompts
// Funções puras (sem rede): montam { sistema, prompt, maxTokens } para a IA.
function montarPromptPlano(arg) {
  const codigoBncc = arg.match(/\b(EF|EI|EM)\d{2}[A-Z]{2}\d{2}\b/i);
  const habilidade = codigoBncc
    ? 'Habilidade BNCC: ' + codigoBncc[0].toUpperCase() + ' (use-a exatamente como informada; se não souber a descrição oficial, escreva o código e o tema, sem inventar a descrição)'
    : 'Tema: ' + arg;
  const prompt = 'Escreva um plano de aula completo e prático, em português, alinhado à BNCC.\n' +
    habilidade + '\nDuração: 50 minutos\n\n' +
    'Responda em texto puro (sem HTML, sem markdown), com as seções numeradas: 1. Objetivos; 2. Habilidade BNCC; 3. Desenvolvimento com tempos em minutos; 4. Atividades; 5. Avaliação; 6. Recursos; 7. Adaptações. Seja concreto e resuma para caber numa conversa de Telegram, sem cortar nenhuma seção.';
  return { sistema: PROMPT_SISTEMA_PLANO, prompt, maxTokens: MAX_TOKENS_PLANO };
}

function montarPromptDocumento(tipo, dados) {
  const def = TIPOS_DOC[tipo];
  const prompt = 'Escreva um(a) ' + def.nome + ' completo(a), em português, em texto puro (sem HTML, sem markdown), pronto para o professor revisar e entregar.\n\nDados:\n' +
    (dados || 'nenhum dado informado') +
    '\n\nRegras: use SOMENTE os dados acima — não invente nomes, datas ou fatos. O que não foi informado, deixe como "a preencher". Estruture com títulos em maiúsculas e seções numeradas, como um documento escolar formal.';
  return { sistema: PROMPT_SISTEMA_AGENTE, prompt, maxTokens: MAX_TOKENS_DOCUMENTO };
}

function montarPromptChat(texto) {
  return { sistema: PROMPT_SISTEMA_CHAT, prompt: texto, maxTokens: MAX_TOKENS_CHAT };
}

// ---------------------------------------------------------- Chamada à IA
// Usa a função interna do proxy (ia.js). Lança Error com mensagem em
// pt-BR quando a chave falta ou a API falha — quem chama transforma em
// resposta amigável ao usuário, sem detalhe técnico.
async function chamarMaritaca(sistema, prompt, maxTokens) {
  const chave = process.env.MARITACA_API_KEY || '';
  if (!chave) {
    throw new Error('IA desligada no servidor.');
  }
  const prov = {
    endpoint: 'https://chat.maritaca.ai/api/chat/completions',
    modelo: process.env.MARITACA_MODEL || 'sabia-4-thinking',
    chave,
  };
  const out = await chamarProvedorOpenAI(prov, [
    { role: 'system', content: sistema },
    { role: 'user', content: prompt },
  ], 0.7, maxTokens);
  return out.text;
}

// ---------------------------------------------------------- Processamento
async function processarMensagem(chatId, texto, tipoChat) {
  const rota = interpretarMensagem(texto);

  if (rota.acao === 'start') {
    await enviarMensagem(chatId, TEXTO_START);
    return;
  }
  if (rota.acao === 'ajuda') {
    await enviarMensagem(chatId, textoAjuda());
    return;
  }
  if (rota.acao === 'desconhecido') {
    await enviarMensagem(chatId, 'Não conheço esse comando. Digite /ajuda para ver o que eu faço.');
    return;
  }
  // Em grupos, o Brito só responde comandos — conversa livre só no privado.
  if (tipoChat !== 'private' && rota.acao === 'chat') {
    return;
  }

  if (rota.acao === 'plano' && !rota.arg) {
    await enviarMensagem(chatId, 'Me diga a habilidade BNCC ou o tema do plano.\nEx.: /plano EF06CI01\nEx.: /plano Misturas homogêneas e heterogêneas, 6º ano');
    return;
  }
  if (rota.acao === 'documento' && !rota.tipoDoc) {
    await enviarMensagem(chatId, 'Qual documento? Use um destes tipos:\n' +
      Object.keys(TIPOS_DOC).join(', ') + '\n\nEx.: /documento ata 25/11/2026, 6º ano B, reunião de pais');
    return;
  }

  const tipoUso = rota.acao === 'plano' || rota.acao === 'documento' ? 'plano' : 'mensagem';
  const permissao = podeUsar(chatId, tipoUso);
  if (!permissao.ok) {
    await enviarMensagem(chatId, textoLimite(permissao.motivo));
    return;
  }
  registrarUso(chatId, tipoUso);

  let pedido;
  if (rota.acao === 'plano') pedido = montarPromptPlano(rota.arg);
  else if (rota.acao === 'documento') pedido = montarPromptDocumento(rota.tipoDoc, rota.arg);
  else pedido = montarPromptChat(rota.arg);

  await enviarAcao(chatId, 'typing');
  try {
    const resposta = await chamarMaritaca(pedido.sistema, pedido.prompt, pedido.maxTokens);
    const limpa = String(resposta || '').replace(/```/g, '').trim();
    if (!limpa) throw new Error('Resposta vazia.');
    await enviarMensagem(chatId, limpa);
    log('chat ' + chatId + ' -> ' + rota.acao + ' ok');
  } catch (e) {
    // Erro genérico ao usuário, sem detalhe técnico e sem vazar nada.
    log('chat ' + chatId + ' -> ' + rota.acao + ' erro: ' + e.message);
    await enviarMensagem(chatId, 'Não consegui falar com a IA agora. Tente de novo em alguns instantes — se o problema continuar, tente mais tarde.');
  }
}

// Um update do Telegram: { update_id, message: { chat, text, from, ... } }.
// Updates sem mensagem de texto (foto, figurinha, edição, callback...)
// são ignorados em silêncio. Devolve sempre — nunca lança.
async function processarUpdate(update) {
  if (!botAtivo()) {
    logInerteUmaVez();
    return;
  }
  try {
    const msg = update && update.message;
    if (!msg || typeof msg.text !== 'string') return;
    if (msg.from && msg.from.is_bot) return;
    const chatId = msg.chat && msg.chat.id;
    if (!chatId) return;
    const tipoChat = (msg.chat && msg.chat.type) || 'private';
    await processarMensagem(chatId, msg.text, tipoChat);
  } catch (e) {
    log('update erro: ' + e.message);
  }
}

// ---------------------------------------------------------- Webhook HTTP
function lerCorpoWebhook(req) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const partes = [];
    req.on('data', (c) => {
      total += c.length;
      if (total > MAX_CORPO_WEBHOOK_BYTES) {
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

// Rota POST /api/telegram (server.js). Responde 200 imediatamente — o
// Telegram reenvia o update se demorar — e processa em segundo plano.
// Sem token, responde 200 e ignora (bot inerte, sem derrubar nada).
async function tratarWebhook(req, res) {
  let corpo;
  try {
    corpo = JSON.parse(await lerCorpoWebhook(req));
  } catch (e) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, erro: 'Corpo da requisição não é um JSON válido.' }));
    return;
  }
  // Segredo opcional do webhook (TELEGRAM_WEBHOOK_SECRET): quando
  // configurado, o Telegram envia o mesmo valor no cabeçalho
  // X-Telegram-Bot-Api-Secret-Token. Sem o segredo, qualquer um pode
  // postar updates falsos — com ele, só o Telegram.
  const segredo = webhookSecret();
  if (segredo) {
    const recebido = req.headers['x-telegram-bot-api-secret-token'];
    if (recebido !== segredo) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, erro: 'Segredo do webhook inválido.' }));
      return;
    }
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true }));
  // Processa em segundo plano, sem segurar a resposta do Telegram.
  processarUpdate(corpo).catch((e) => log('update erro: ' + e.message));
}

// ---------------------------------------------------------- Registro do webhook
// Corpo do setWebhook — função pura, para os testes verificarem o formato.
function montarCorpoWebhook() {
  const corpo = { url: webhookUrl() };
  if (webhookSecret()) corpo.secret_token = webhookSecret();
  return corpo;
}

// Registra o webhook na Bot API. Chamado na inicialização do servidor
// (server.js) quando há token. Devolve true quando o Telegram aceitou.
// Não registra nada quando não há token (bot inerte) ou quando
// TELEGRAM_AUTO_REGISTRO=0 (registro manual, pelo painel ou por curl).
async function registrarWebhook() {
  if (!botAtivo()) {
    log('sem TELEGRAM_BOT_TOKEN — webhook não registrado, bot inerte');
    return false;
  }
  if (!registroAutomatico()) {
    log('TELEGRAM_AUTO_REGISTRO=0 — registro automático desligado');
    return false;
  }
  const corpo = montarCorpoWebhook();
  const r = await chamarTelegram('setWebhook', corpo);
  if (r && r.ok) {
    log('webhook registrado em ' + corpo.url);
    return true;
  }
  log('falha ao registrar o webhook (a API do Telegram recusou)');
  return false;
}

module.exports = {
  botAtivo,
  registrarWebhook,
  tratarWebhook,
  processarUpdate,
  // Exportados para os testes (funções puras, sem rede):
  dividirTexto,
  interpretarMensagem,
  montarPromptPlano,
  montarPromptDocumento,
  montarPromptChat,
  montarCorpoWebhook,
  podeUsar,
  registrarUso,
  usoDoChat,
  textoLimite,
  TIPOS_DOC,
  LIMITE_PLANOS_DIA,
  LIMITE_MSGS_DIA,
};
