# Testes do Brito no Telegram — relatório

Data: 26/11/2026. Rodar com: `node testes-telegram.js` (na pasta `proxy`).
Resultado: **40 PASS, 0 FAIL** (saída 0).

## A. Funções puras — 26 testes (sem rede)

- `dividirTexto`: texto curto (1 parte), 9.000 caracteres (3 partes ≤ 4096,
  junção idêntica ao original), corte preferencial na quebra de parágrafo
  (quando passa da metade), corte no limite sem quebra útil, texto vazio.
- `interpretarMensagem`: `/start`, `/ajuda`, `/plano` com código BNCC,
  `/plano` sem argumento, `/documento ata` com dados, `/documento
  "relatório de turma"`, `/documento "lista de chamada"` (apelido longo
  casa antes do curto), tipo desconhecido, texto livre (chat), comando
  desconhecido.
- `montarPromptPlano`: código BNCC vai como habilidade com a regra "sem
  inventar a descrição"; tema livre vai como tema; seções e formato
  "texto puro, sem HTML, sem markdown" presentes; max_tokens 3000.
- `montarPromptDocumento`: ata com dados, regra "não invente nomes,
  datas ou fatos"; max_tokens 2000.
- `montarPromptChat`: sistema é o Brito, em pt-BR.
- `TIPOS_DOC`: os 8 documentos do MVP.
- Limites: 5 planos/dia (o 6º é negado, motivo "planos"), 30
  mensagens/dia (a 31ª é negada, motivo "mensagens"), um usuário no
  limite não afeta outro.
- `montarCorpoWebhook`: URL padrão `https://brittech-proxy.onrender.com/api/telegram`, sem segredo.
- `botAtivo()`: falso sem `TELEGRAM_BOT_TOKEN`.
- `processarUpdate` sem token: inerte, não lança nada.

## B. Servidor sem chaves — 9 testes (webhook inerte + endpoints existentes)

Servidor subido na porta 18099, sem `MARITACA_API_KEY` e sem
`TELEGRAM_BOT_TOKEN`:

- `GET /health`: 200, `telegram.botConfigurado=false`.
- `POST /api/telegram` com `/start`, `/plano EF06CI01` e texto livre:
  200 em todos, bot inerte, sem chamar a IA e sem crash.
- `POST /api/telegram` com JSON inválido: 400; update sem `message`: 200.
- `POST /api/chat` (maritaca, sem chave): 500 com erro em pt-BR.
- `POST /api/tts` (personagem inválido): 400.
- Rota inexistente: 404 citando `/api/telegram`.

## B2. Segredo do webhook — 3 testes

Servidor com `TELEGRAM_WEBHOOK_SECRET=segredo-teste-123`: sem o
cabeçalho → 403; com o segredo errado → 403; com o segredo certo → 200.

## C. Envio real à API do Telegram — 2 testes (no máximo 1 chamada)

Servidor com token falso e `TELEGRAM_AUTO_REGISTRO=0` (o registro do
webhook NÃO acontece na inicialização):

- `POST /api/telegram` com `/start`: webhook responde 200 e há exatamente
  **1 tentativa de `sendMessage`**, recusada pelo Telegram (401 para
  token inválido ou 404 para token inexistente/malformado).
- Servidor continua de pé depois da recusa (`GET /health` 200,
  `telegram.botConfigurado=true`).

Ressalva desta VM: o acesso à internet passa por um proxy de saída que
às vezes derruba o túnel ("proxy tunnel timed out") — numa das rodadas
o envio falhou com erro de rede em vez de 401/404. Isso é limitação da
VM de teste, não do bot: no Render a internet é direta. O `postJson`
ganhou timeout de 20 s para uma API lenta não deixar a requisição
pendurada.

## Verificação ao vivo com o token real (26/11/2026)

Feita com o token criado pelo Thiago no @BotFather, usado só de forma
transitória (via stdin, sem gravar em arquivo, log ou relatório):

- `getMe`: token **válido**. Bot: username `brito_edu_bot`
  (nome "Brito.Edu.bot").
- `getUpdates`: lista vazia — ninguém mandou mensagem ao bot ainda,
  então não existe nenhum chat para enviar a mensagem de teste (um bot
  não pode iniciar conversa com quem nunca falou com ele).
- Validação do envio: `sendMessage` para um chat inexistente voltou
  HTTP 400 "chat not found" — ou seja, o token foi **aceito**
  (a autenticação passou; falhou só o chat, que não existe). Nada foi
  entregue a ninguém.
- **Nenhum webhook foi registrado** nesta etapa (o registro acontece no
  Render, depois do deploy, quando o token estiver na env de lá).

Para o teste de envio de verdade, o Thiago precisa mandar `/start`
para `@brito_edu_bot` no Telegram — aí o bot passa a ter o chat dele e
responde.

## NÃO testado aqui (precisa do token real + chave da Maritaca, após o deploy)

- `setWebhook` aceito pelo Telegram e mensagens chegando de verdade
  pelo webhook.
- `/plano` e `/documento` com a IA real (texto gerado pela Maritaca).
- Conversa livre com a IA real.
- Divisão de uma resposta real maior que 4096 caracteres.
- Limite diário com uso real (o contador é em memória e zera no restart).
