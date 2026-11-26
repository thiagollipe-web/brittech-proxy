// Brittech Educação — testes do bot do Telegram (testes-telegram.js)
// Testes locais, sem token real e sem chave da Maritaca.
// Rode com:  node testes-telegram.js
// O script testa as funções puras do telegram.js, sobe o servidor em
// portas de teste (sem chaves) para verificar o webhook inerte e os
// endpoints existentes, e faz NO MÁXIMO 1 chamada à API real do Telegram
// (um sendMessage com token falso, que deve voltar 401 — prova que o
// envio chega à API com o formato certo, sem gastar nada).
// Saída: PASS/FAIL por teste + resumo. Código de saída 0 = tudo passou.
'use strict';

const assert = require('node:assert');
const { spawn } = require('node:child_process');
const path = require('node:path');

const tg = require('./telegram');

let passou = 0;
let falhou = 0;
const falhas = [];

function teste(nome, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') {
      return r.then(
        () => { passou++; console.log('PASS  ' + nome); },
        (e) => { falhou++; falhas.push(nome + ': ' + e.message); console.log('FAIL  ' + nome + ' — ' + e.message); },
      );
    }
    passou++;
    console.log('PASS  ' + nome);
  } catch (e) {
    falhou++;
    falhas.push(nome + ': ' + e.message);
    console.log('FAIL  ' + nome + ' — ' + e.message);
  }
  return Promise.resolve();
}

// ---------------------------------------------------------- Parte A — funções puras
async function parteA() {
  console.log('\n== A. Funções puras (sem rede) ==');

  await teste('dividirTexto: texto curto vira 1 parte', () => {
    assert.deepStrictEqual(tg.dividirTexto('oi'), ['oi']);
  });
  await teste('dividirTexto: 9000 caracteres viram 3 partes <= 4096 e a junção é o original', () => {
    const longo = 'abcdefghij'.repeat(900); // 9000 caracteres
    const partes = tg.dividirTexto(longo);
    assert.strictEqual(partes.length, 3);
    partes.forEach((p) => assert.ok(p.length <= 4096, 'parte com ' + p.length));
    assert.strictEqual(partes.join(''), longo);
  });
  await teste('dividirTexto: prefere cortar na quebra de parágrafo (quando ela passa da metade)', () => {
    const texto = 'a'.repeat(3000) + '\n\n' + 'b'.repeat(3000);
    const partes = tg.dividirTexto(texto);
    assert.ok(partes[0].endsWith('\n\n'), 'primeira parte deveria terminar no fim do parágrafo');
    assert.strictEqual(partes.join(''), texto);
  });
  await teste('dividirTexto: sem quebra útil, corta no limite', () => {
    const texto = 'x'.repeat(5000);
    const partes = tg.dividirTexto(texto);
    assert.strictEqual(partes[0].length, 4096);
    assert.strictEqual(partes.join(''), texto);
  });
  await teste('dividirTexto: texto vazio vira 0 partes', () => {
    assert.deepStrictEqual(tg.dividirTexto(''), []);
  });

  await teste('interpretarMensagem: /start', () => {
    assert.deepStrictEqual(tg.interpretarMensagem('/start'), { acao: 'start', arg: '', tipoDoc: null });
  });
  await teste('interpretarMensagem: /ajuda', () => {
    assert.strictEqual(tg.interpretarMensagem('/ajuda').acao, 'ajuda');
  });
  await teste('interpretarMensagem: /plano com código BNCC', () => {
    const r = tg.interpretarMensagem('/plano EF06CI01');
    assert.strictEqual(r.acao, 'plano');
    assert.strictEqual(r.arg, 'EF06CI01');
  });
  await teste('interpretarMensagem: /plano sem argumento', () => {
    const r = tg.interpretarMensagem('/plano');
    assert.strictEqual(r.acao, 'plano');
    assert.strictEqual(r.arg, '');
  });
  await teste('interpretarMensagem: /documento ata com dados', () => {
    const r = tg.interpretarMensagem('/documento ata 25/11/2026, 6º ano B, reunião de pais');
    assert.strictEqual(r.acao, 'documento');
    assert.strictEqual(r.tipoDoc, 'ata');
    assert.strictEqual(r.arg, '25/11/2026, 6º ano B, reunião de pais');
  });
  await teste('interpretarMensagem: /documento "relatório de turma"', () => {
    const r = tg.interpretarMensagem('/documento relatório de turma 2º ano B');
    assert.strictEqual(r.tipoDoc, 'relatorio');
  });
  await teste('interpretarMensagem: /documento "lista de chamada" (apelido longo antes do curto)', () => {
    const r = tg.interpretarMensagem('/documento lista de chamada 6º ano A');
    assert.strictEqual(r.tipoDoc, 'lista-chamada');
  });
  await teste('interpretarMensagem: /documento com tipo desconhecido', () => {
    const r = tg.interpretarMensagem('/documento xyz');
    assert.strictEqual(r.acao, 'documento');
    assert.strictEqual(r.tipoDoc, null);
  });
  await teste('interpretarMensagem: texto livre vira chat', () => {
    const r = tg.interpretarMensagem('como faço uma ata?');
    assert.strictEqual(r.acao, 'chat');
  });
  await teste('interpretarMensagem: comando desconhecido', () => {
    assert.strictEqual(tg.interpretarMensagem('/inventado').acao, 'desconhecido');
  });

  await teste('montarPromptPlano: código BNCC vai como habilidade, sem inventar descrição', () => {
    const p = tg.montarPromptPlano('EF06CI01');
    assert.ok(p.prompt.includes('EF06CI01'), 'código ausente');
    assert.ok(p.prompt.includes('sem inventar a descrição'), 'regra anti-invenção ausente');
    assert.ok(p.prompt.includes('1. Objetivos'), 'seções ausentes');
    assert.ok(p.prompt.includes('texto puro (sem HTML, sem markdown)'), 'formato Telegram ausente');
    assert.strictEqual(p.maxTokens, 3000);
  });
  await teste('montarPromptPlano: tema livre vai como tema', () => {
    const p = tg.montarPromptPlano('Misturas homogêneas, 6º ano');
    assert.ok(p.prompt.includes('Tema: Misturas homogêneas, 6º ano'));
  });
  await teste('montarPromptDocumento: ata com dados', () => {
    const p = tg.montarPromptDocumento('ata', '25/11/2026, 6º ano B, reunião de pais');
    assert.ok(p.prompt.includes('ata de reunião'));
    assert.ok(p.prompt.includes('25/11/2026, 6º ano B, reunião de pais'));
    assert.ok(p.prompt.includes('não invente nomes, datas ou fatos'));
    assert.strictEqual(p.maxTokens, 2000);
  });
  await teste('montarPromptChat: sistema é o Brito', () => {
    const p = tg.montarPromptChat('oi');
    assert.ok(p.sistema.includes('Você é o Brito'));
    assert.ok(p.sistema.includes('português brasileiro'));
  });
  await teste('TIPOS_DOC: os 8 documentos do MVP', () => {
    assert.deepStrictEqual(Object.keys(tg.TIPOS_DOC).sort(), [
      'ata', 'comunicado', 'ficha', 'lista-chamada',
      'parecer', 'planejamento-anual', 'relatorio', 'sequencia',
    ]);
  });

  await teste('limites: 5 planos/dia por usuário; o 6º é negado', () => {
    const chat = 900001;
    for (let i = 0; i < 5; i++) {
      assert.ok(tg.podeUsar(chat, 'plano').ok, 'plano ' + (i + 1) + ' negado cedo');
      tg.registrarUso(chat, 'plano');
    }
    const negado = tg.podeUsar(chat, 'plano');
    assert.strictEqual(negado.ok, false);
    assert.strictEqual(negado.motivo, 'planos');
    assert.ok(tg.textoLimite('planos').includes('5 planos'));
  });
  await teste('limites: 30 mensagens/dia por usuário; a 31ª é negada', () => {
    const chat = 900002;
    for (let i = 0; i < 30; i++) {
      assert.ok(tg.podeUsar(chat, 'mensagem').ok, 'mensagem ' + (i + 1) + ' negada cedo');
      tg.registrarUso(chat, 'mensagem');
    }
    const negado = tg.podeUsar(chat, 'mensagem');
    assert.strictEqual(negado.ok, false);
    assert.strictEqual(negado.motivo, 'mensagens');
  });
  await teste('limites: um usuário no limite não afeta outro', () => {
    assert.ok(tg.podeUsar(900003, 'plano').ok);
    assert.ok(tg.podeUsar(900003, 'mensagem').ok);
  });
  await teste('montarCorpoWebhook: URL padrão do Render, sem segredo', () => {
    assert.deepStrictEqual(tg.montarCorpoWebhook(), { url: 'https://brittech-proxy.onrender.com/api/telegram' });
  });
  await teste('botAtivo: falso sem TELEGRAM_BOT_TOKEN', () => {
    assert.strictEqual(tg.botAtivo(), false);
  });
  await teste('processarUpdate sem token: inerte, não lança nada', async () => {
    await tg.processarUpdate({ update_id: 1, message: { chat: { id: 1, type: 'private' }, text: '/start', from: { id: 1 } } });
  });
}

// ---------------------------------------------------------- Parte B/C — servidor
function subirServidor(porta, envExtra) {
  return new Promise((resolve, reject) => {
    const filho = spawn('node', ['server.js'], {
      cwd: __dirname,
      env: Object.assign({}, process.env, { PORT: String(porta) }, envExtra || {}),
    });
    let saida = '';
    let pronto = false;
    const timer = setTimeout(() => {
      if (!pronto) reject(new Error('servidor na porta ' + porta + ' não subiu em 10 s. Saída: ' + saida));
    }, 10000);
    filho.stdout.on('data', (d) => {
      saida += d.toString();
      if (!pronto && saida.includes('ouvindo na porta')) {
        pronto = true;
        clearTimeout(timer);
        resolve({ filho, obterSaida: () => saida });
      }
    });
    filho.stderr.on('data', (d) => { saida += d.toString(); });
    filho.on('error', reject);
  });
}

async function postJsonLocal(porta, caminho, corpo, headersExtras) {
  const r = await fetch('http://127.0.0.1:' + porta + caminho, {
    method: 'POST',
    headers: Object.assign({ 'Content-Type': 'application/json' }, headersExtras || {}),
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
  const texto = await r.text();
  let json = null;
  try { json = JSON.parse(texto); } catch (e) { /* corpo não-JSON */ }
  return { status: r.status, texto, json };
}

async function parteB() {
  console.log('\n== B. Servidor sem chaves (webhook inerte + endpoints existentes) ==');
  const porta = 18099;
  const srv = await subirServidor(porta, {});
  try {
    await teste('GET /health: 200 e telegram.botConfigurado=false', async () => {
      const r = await fetch('http://127.0.0.1:' + porta + '/health');
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(j.ok, true);
      assert.strictEqual(j.telegram.botConfigurado, false);
      assert.strictEqual(j.telegram.endpoint, 'POST /api/telegram');
    });
    await teste('POST /api/telegram /start sem token: 200, bot inerte, sem crash', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', {
        update_id: 10,
        message: { message_id: 1, chat: { id: 111, type: 'private' }, from: { id: 111 }, text: '/start' },
      });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ok, true);
    });
    await teste('POST /api/telegram /plano sem token: 200, sem chamar a IA', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', {
        update_id: 11,
        message: { message_id: 2, chat: { id: 111, type: 'private' }, from: { id: 111 }, text: '/plano EF06CI01' },
      });
      assert.strictEqual(r.status, 200);
    });
    await teste('POST /api/telegram texto livre sem token: 200', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', {
        update_id: 12,
        message: { message_id: 3, chat: { id: 111, type: 'private' }, from: { id: 111 }, text: 'oi, Brito' },
      });
      assert.strictEqual(r.status, 200);
    });
    await teste('POST /api/telegram JSON inválido: 400', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', '{não-json');
      assert.strictEqual(r.status, 400);
    });
    await teste('POST /api/telegram update sem message: 200 (ignorado)', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', { update_id: 13 });
      assert.strictEqual(r.status, 200);
    });
    await teste('POST /api/chat maritaca sem chave: 500 em pt-BR (endpoint existente intacto)', async () => {
      const r = await postJsonLocal(porta, '/api/chat', {
        provider: 'maritaca',
        messages: [{ role: 'user', content: 'Responda apenas: ok' }],
      });
      assert.strictEqual(r.status, 500);
      assert.ok(r.json.erro.includes('não configurada'), 'erro inesperado: ' + r.texto);
    });
    await teste('POST /api/tts personagem inválido: 400 (endpoint existente intacto)', async () => {
      const r = await postJsonLocal(porta, '/api/tts', { texto: 'oi', personagem: 'inexistente' });
      assert.strictEqual(r.status, 400);
    });
    await teste('GET /rota-inexistente: 404 citando /api/telegram', async () => {
      const r = await fetch('http://127.0.0.1:' + porta + '/rota-inexistente');
      assert.strictEqual(r.status, 404);
      const j = await r.json();
      assert.ok(j.erro.includes('/api/telegram'));
    });
  } finally {
    srv.filho.kill();
  }
}

async function parteBSegredo() {
  console.log('\n== B2. Segredo do webhook (opcional) ==');
  const porta = 18100;
  const srv = await subirServidor(porta, { TELEGRAM_WEBHOOK_SECRET: 'segredo-teste-123' });
  try {
    const update = {
      update_id: 20,
      message: { message_id: 1, chat: { id: 222, type: 'private' }, from: { id: 222 }, text: '/start' },
    };
    await teste('POST /api/telegram sem o segredo: 403', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', update);
      assert.strictEqual(r.status, 403);
    });
    await teste('POST /api/telegram com o segredo errado: 403', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', update, { 'X-Telegram-Bot-Api-Secret-Token': 'errado' });
      assert.strictEqual(r.status, 403);
    });
    await teste('POST /api/telegram com o segredo certo: 200', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', update, { 'X-Telegram-Bot-Api-Secret-Token': 'segredo-teste-123' });
      assert.strictEqual(r.status, 200);
    });
  } finally {
    srv.filho.kill();
  }
}

// ---------------------------------------------------------- Parte C — 1 chamada real
// O objetivo é provar que o caminho de envio chega à API real do Telegram.
// Ressalva desta VM: o acesso à internet passa por um proxy de saída que
// às vezes demora e derruba o túnel ("proxy tunnel timed out") — nesse
// caso o log mostra 'erro de rede' em vez de HTTP 401. Nos dois casos a
// tentativa aconteceu exatamente 1 vez, e no Render (internet direta)
// esse problema não existe.
async function parteC() {
  console.log('\n== C. Envio real à API do Telegram (NO MÁXIMO 1 chamada, token falso) ==');
  console.log('    Servidor com TELEGRAM_BOT_TOKEN=falso e TELEGRAM_AUTO_REGISTRO=0,');
  console.log('    para o registro do webhook NÃO acontecer na inicialização.');
  const porta = 18101;
  const srv = await subirServidor(porta, {
    TELEGRAM_BOT_TOKEN: 'falso-token-de-teste-123456',
    TELEGRAM_AUTO_REGISTRO: '0',
  });
  try {
    await teste('POST /api/telegram /start com token falso: webhook responde 200 e há exatamente 1 tentativa de sendMessage recusada (401/404 ou erro de rede da VM)', async () => {
      const r = await postJsonLocal(porta, '/api/telegram', {
        update_id: 30,
        message: { message_id: 1, chat: { id: 333, type: 'private' }, from: { id: 333 }, text: '/start' },
      });
      assert.strictEqual(r.status, 200);
      // Dá tempo do processamento em segundo plano tentar o envio
      // (o túnel do proxy desta VM pode levar alguns segundos).
      await new Promise((res) => setTimeout(res, 15000));
      const saida = srv.obterSaida();
      const tentativas = (saida.match(/sendMessage ->/g) || []).length;
      assert.strictEqual(tentativas, 1, 'esperava exatamente 1 tentativa de sendMessage, houve ' + tentativas + '. Saída:\n' + saida);
      // Token falso: o Telegram recusa com 401 (token inválido) ou 404
      // (token inexistente/malformado). Se o proxy de saída desta VM
      // derrubar o túnel, o resultado é 'erro de rede'.
      const recusado = saida.includes('sendMessage -> HTTP 401') ||
        saida.includes('sendMessage -> HTTP 404') ||
        saida.includes('sendMessage -> erro de rede');
      assert.ok(recusado, 'nenhum resultado de sendMessage no log. Saída:\n' + saida);
      if (saida.includes('erro de rede')) console.log('    (aviso: o proxy de saída desta VM derrubou o túnel; no Render isso não acontece)');
      assert.ok(!saida.includes('setWebhook'), 'o registro do webhook não deveria ter acontecido');
    });
    await teste('servidor continua de pé depois do 401 (GET /health 200)', async () => {
      const r = await fetch('http://127.0.0.1:' + porta + '/health');
      assert.strictEqual(r.status, 200);
      const j = await r.json();
      assert.strictEqual(j.telegram.botConfigurado, true);
    });
  } finally {
    srv.filho.kill();
  }
}

// ---------------------------------------------------------- Resumo
(async () => {
  try {
    await parteA();
    await parteB();
    await parteBSegredo();
    await parteC();
  } catch (e) {
    falhou++;
    falhas.push('erro geral: ' + e.message);
    console.log('FAIL  erro geral — ' + e.message);
  }
  console.log('\n== Resumo ==');
  console.log('PASS: ' + passou + ' | FAIL: ' + falhou);
  if (falhas.length) {
    console.log('Falhas:');
    falhas.forEach((f) => console.log('  - ' + f));
  }
  console.log('\nNÃO testado aqui (precisa do token real do @BotFather + chave da Maritaca):');
  console.log('  - setWebhook aceito pelo Telegram e mensagens chegando de verdade;');
  console.log('  - /plano e /documento com a IA real (texto gerado pela Maritaca);');
  console.log('  - conversa livre com a IA real;');
  console.log('  - divisão de uma resposta real maior que 4096 caracteres.');
  process.exit(falhou ? 1 : 0);
})();
