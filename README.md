# Proxy da Brittech Educação — entre o MVP e as APIs de IA

> **Por que existe:** a Maritaca e a DeepSeek não enviam cabeçalhos CORS,
> então o navegador bloqueia a chamada direta do MVP (“Failed to fetch”).
> O proxy fica no servidor, chama a API com a chave (que **nunca sai do
> servidor**) e devolve só o texto ao navegador.
>
> **Deploy escolhido: Render, plano gratuito** — os links são mais fáceis
> (uma URL `.onrender.com` pronta). A alternativa Cloudflare Workers
> (também gratuita) está no fim deste README, em poucas linhas.

## O que tem nesta pasta

| Arquivo | Para quê |
|---|---|
| `server.js` | O proxy em Node.js (só biblioteca padrão — nada para instalar). Endpoints: `POST /api/chat`, `POST /api/live-token` (conversa ao vivo), `POST /api/tts` (vozes neurais), `POST /api/telegram` (webhook do Brito no Telegram) e `GET /health`. |
| `ia.js` | Chamadas à IA usadas pelo `/api/chat` e pelo bot do Telegram (`postJson`, `chamarProvedorOpenAI`). |
| `telegram.js` | O Brito no Telegram: recebe os updates do webhook, interpreta os comandos e chama a Maritaca pela função interna. |
| `testes-telegram.js` | Testes do bot (rode com `node testes-telegram.js`). |
| `TESTES-TELEGRAM.md` | Relatório da última rodada de testes do bot. |
| `edge-tts.js` | Cliente do Edge TTS (Microsoft, grátis, sem chave): abre o WebSocket, manda o SSML e devolve o MP3. |
| `edge-drm.js` | Token Sec-MS-GEC v2 do Edge TTS, portado do pacote Python edge-tts e verificado contra vetores do Python. |
| `package.json` | Identifica o projeto para o Render (`npm start` → `node server.js`). |
| `render.yaml` | Blueprint do Render: cria o web service gratuito sozinho. |
| `worker.js` | Alternativa Cloudflare Workers (mesma lógica, sem servidor). |
| `brittech-proxy.service` | Opção avançada (systemd) — só se um dia houver um servidor próprio. O Thiago **não** tem VPS; ignore este arquivo por enquanto. |

## Como funciona

1. O MVP chama `POST https://<seu-servico>.onrender.com/api/chat` com
   `{ provider, messages, temperature, max_tokens }`.
2. O proxy valida o corpo (`messages` é um array não vazio), pega a chave
   do provedor **da variável de ambiente do servidor** e repassa para a API:
   - **Maritaca** → `https://chat.maritaca.ai/api/chat/completions`, modelo
     `sabia-4-thinking` (padrão; troque com `MARITACA_MODEL`).
   - **DeepSeek** → `https://api.deepseek.com/chat/completions`, modelo
     `deepseek-chat` (padrão; troque com `DEEPSEEK_MODEL`).
   - **Gemini** → API nativa do Google, modelo `gemini-2.5-flash-lite`
     (padrão; troque com `GEMINI_MODEL`).
3. O proxy devolve `{ provider, modelo, text }` (e `uso`, quando a API
   informa). Erros da API voltam com o status e uma mensagem curta —
   **sem vazar a chave**.
4. CORS liberado só para o MVP: `https://thiagollipe-web.github.io` e
   `localhost` (teste local). Para liberar outro domínio, acrescente a
   origem exata em `ALLOWED_ORIGINS` (separada por vírgula).

O navegador **nunca envia nem recebe a chave** — ele nem sabe que ela
existe. Log mínimo no servidor (data, provedor, status), sem registrar
chave nem conteúdo das mensagens.

## Rodar local (para testar)

```bash
cd proxy
node server.js
# Proxy ouvindo na porta 8787 (mude com PORT=9000 node server.js)
```

Teste de saúde:

```bash
curl http://localhost:8787/health
# {"ok":true,"provedores":["maritaca","deepseek","gemini"],"chavesConfiguradas":[]}
```

Sem chave no servidor, o erro é claro (não é CORS):

```bash
curl -X POST http://localhost:8787/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"provider":"maritaca","messages":[{"role":"user","content":"Responda apenas: ok"}]}'
# {"erro":"Chave da API do provedor \"maritaca\" não configurada no servidor. ..."}
```

## Conversa ao vivo — `POST /api/live-token`

A Sala de Aula Online tem a página `conversa.html`: o aluno fala por voz
com o professor (Gemini Live API, áudio-para-áudio, como uma ligação).
O navegador **nunca recebe a chave Gemini**: ele pede um token efêmero
ao proxy e abre o WebSocket direto com o Google usando esse token.

```bash
curl -X POST http://localhost:8787/api/live-token \
  -H 'Content-Type: application/json' \
  -d '{"tema":"Misturas homogêneas e heterogêneas","conteudo":"...","nomeAluno":"Ana"}'
# Sem a chave: {"erro":"Falta a chave Gemini no servidor. No painel do Render ..."}
# Com a chave: {"token":"auth_tokens/...","modelo":"gemini-3.8-live","vozProfessor":"Aoede","expiraEmSegundos":1800}
```

O token vale para **1 sessão**, expira em 30 min e só aceita abrir a
sessão nos 60 s seguintes. Ele já vem travado ao modelo
(`gemini-3.8-live`, ou `GEMINI_LIVE_MODEL`) e à configuração da aula
(voz do professor `Aoede`, ou `GEMINI_LIVE_VOZ`, e a instrução do
professor montada com o tema e o conteúdo). Antiabuso: no máximo 10
tokens por IP a cada 5 minutos.

**Para ligar a conversa ao vivo no Render**, crie a variável
`GEMINI_API_KEY` no painel do serviço (Render → brittech-proxy →
Environment Variables) com a chave do Google AI Studio
(https://aistudio.google.com/apikey) e aguarde o reinício automático.
Sem ela, a página `conversa.html` mostra o erro em português e não abre
a conversa. A chave da Maritaca continua servindo para os colegas
(Curioso, Anotador, Pensador) e para o resto do MVP.

## Voz neural brasileira — `POST /api/tts`

A Sala de Aula Online tem a página `conversa-turnos.html`: conversa por
turnos (o aluno fala ou escreve, o professor responde por voz), com
vozes neurais brasileiras do **Microsoft Edge TTS — grátis, sem chave**.
O proxy faz a síntese no servidor e devolve o MP3; o navegador nunca
fala direto com a Microsoft.

```bash
curl -X POST http://localhost:8787/api/tts \
  -H 'Content-Type: application/json' \
  -d '{"texto":"Oi, pessoal! Bem-vindos à aula.","personagem":"professora"}' \
  --output fala.mp3
# Devolve o MP3 (audio/mpeg). Sem personagem válido:
# {"erro":"Informe o personagem (\"professora\", \"curioso\", \"anotador\" ou \"pensador\") ..."}
```

| Personagem | Voz Edge TTS | Ritmo base |
|---|---|---|
| `professora` | pt-BR-FranciscaNeural | +0%, +0st |
| `pensador` | pt-BR-AntonioNeural | −5%, −2st |
| `anotador` | pt-BR-ThalitaMultilingualNeural | +0%, +0st |
| `curioso` | pt-BR-AntonioNeural | +25%, +6st |

Só existem 3 vozes pt-BR no Edge TTS: o Curioso usa a mesma base do
Pensador (AntonioNeural), mas bem mais rápido e agudo — no teste local,
o mesmo texto saiu com 3,06 s (Curioso) contra 4,02 s (Pensador).
O campo opcional `tom` ajusta o ritmo: `"pergunta"` (+10 pontos, mais
rápido) e `"resposta"` (−5 pontos, mais calmo). Também aceita `voz` com
o nome exato de uma das 3 vozes, em vez de `personagem`. Texto de 1 a
2000 caracteres. Antiabuso: no máximo 60 falas por IP a cada 5 minutos.

Implementação (sem dependência externa, mesma convenção do proxy): o
`edge-tts.js` abre o WebSocket da Microsoft com o protocolo do pacote
Python edge-tts (mensagens `speech.config` + `ssml`, áudio MP3 24 kHz
de volta) e o `edge-drm.js` calcula o token `Sec-MS-GEC` v2 — um
SHA-256 modificado + CS64 — verificado contra 4 vetores gerados pelo
próprio Python (os valores batem exatamente). Se a Microsoft mudar o
protocolo, o endpoint devolve 502 em pt-BR e a página usa a voz do
aparelho (fallback) — a aula nunca fica muda.

## Brito no Telegram — `POST /api/telegram`

O agente Brito também atende no Telegram, com a **mesma IA real do MVP**
(Maritaca sabia-4-thinking) e os **mesmos prompts e persona** do agente do
MVP (`mvp/agente.js` e `mvp/app.js`). A diferença do WhatsApp Business
(que cobra por conversa) é que a **Bot API do Telegram é grátis**.

Como funciona: o Telegram entrega cada mensagem como um "update" no
webhook `POST /api/telegram`. O proxy interpreta, chama a Maritaca pela
função interna (nunca por HTTP para o próprio serviço) e devolve a
resposta com `sendMessage`. O webhook responde 200 na hora e processa em
segundo plano — se a IA demorar, o Telegram não reenvia o update.

| Comando | O que faz |
|---|---|
| `/start` | Apresentação curta do Brito + o que ele faz. |
| `/ajuda` | Lista todos os comandos. |
| `/plano <habilidade BNCC ou tema>` | Gera um plano de aula com a IA real (mesmo formato do planejador do MVP, resumido para o Telegram). Ex.: `/plano EF06CI01` ou `/plano Misturas, 6º ano`. |
| `/documento <tipo> <dados>` | Gera um dos 8 documentos do agente (ata, relatório de turma, parecer descritivo, ficha de avaliação, planejamento anual, sequência didática, comunicado aos pais, lista de chamada) como texto formatado. Ex.: `/documento ata 25/11/2026, 6º ano B, reunião de pais`. O que não for informado vira "a preencher" (mesma regra do MVP). |
| texto livre | Conversa com o Brito via IA (mesma persona do MVP). |

Detalhes: o bot manda "digitando..." (`sendChatAction`) antes de
responder; respostas acima de 4096 caracteres são divididas em várias
mensagens; erros da IA voltam como mensagem clara em pt-BR, sem detalhe
técnico. Em grupos, o Brito só responde comandos. **Planilhas (.xlsx)
ficam para a v2** — no Telegram, só texto por enquanto. O fluxo de
perguntas do MVP (até 2 rodadas pedindo o que falta) também ainda não
existe aqui: no `/documento`, os dados vão junto no comando.

**Limites diários por usuário (para o custo da Maritaca não estourar):**
5 planos/documentos e 30 mensagens por dia, por usuário. `/start` e
`/ajuda` não gastam nada; `/plano` e `/documento` gastam 1 plano E 1
mensagem. Contador em memória (sem banco de dados): zera à meia-noite
(UTC) e quando o serviço reinicia. Ajuste com `TELEGRAM_LIMITE_PLANOS_DIA`
e `TELEGRAM_LIMITE_MSGS_DIA`.

**Sem `TELEGRAM_BOT_TOKEN`, o bot fica inerte** — o webhook responde 200
e ignora tudo, e o resto do proxy (`/api/chat`, `/api/tts`, `/health`)
continua igual. `GET /health` mostra `telegram.botConfigurado`.

### Ligar o bot no Render — passo a passo

1. No Telegram, abra o **@BotFather** e mande `/newbot`. Responda o nome
   (ex.: `Brito Educação`) e o username (ex.: `brito_edu_bot`) — o
   @BotFather devolve o **token** (parecido com `123456789:AAE...`).
2. No painel do Render (brittech-proxy → **Environment Variables**), crie
   a variável **`TELEGRAM_BOT_TOKEN`** com o token e salve. O Render
   reinicia o serviço sozinho.
3. No restart, o proxy **registra o webhook sozinho** na Bot API para
   `https://brittech-proxy.onrender.com/api/telegram`. Confira no log:
   "telegram: webhook registrado em https://brittech-proxy.onrender.com/api/telegram".
4. No Telegram, abra o bot e mande `/start`. Pronto — o Brito responde.
   (Opcional: `TELEGRAM_WEBHOOK_SECRET` com um valor qualquer — o mesmo
   valor tem que ir no `setWebhook`; o proxy já valida o cabeçalho
   `X-Telegram-Bot-Api-Secret-Token` quando a variável existe.)

> **O token nunca vai para o código, para o GitHub nem para o navegador**
> — só na variável de ambiente do Render. Se vazar, apague o bot no
> @BotFather (`/deletebot`) ou gere outro token (`/revoke`).
>
> **Atenção: o plano gratuito "dorme"** — depois de ~15 minutos sem uso,
> a primeira mensagem ao bot pode demorar ~30–60 s para "acordar" o
> serviço. As seguintes são normais. O `worker.js` (Cloudflare) ainda
> não inclui o bot — só o `server.js` no Render.

Testes: `node testes-telegram.js` (40 testes; relatório em
`TESTES-TELEGRAM.md`). Sem token real, a suíte testa as funções puras,
o webhook inerte e os endpoints existentes, e faz no máximo 1 chamada
à API real do Telegram com token falso (recusada com 401/404).

## Deploy no Render (plano gratuito) — caminho principal

### 1. Subir a pasta `proxy` para um repositório no GitHub

O Render lê o código do GitHub. Se a pasta `proxy` ainda não estiver num
repositório, crie um (ex.: `brittech-proxy`) com estes arquivos:
`server.js`, `edge-tts.js`, `edge-drm.js`, `package.json`, `render.yaml`
(o `worker.js` pode ir junto; o Render ignora). Não coloque chave nenhuma nos arquivos.

### 2. Criar o web service gratuito

1. Abra https://dashboard.render.com → **New → Web Service**.
2. Conecte o repositório do passo 1 e escolha o branch.
3. O Render detecta o `render.yaml` e preenche sozinho: runtime **Node**,
   plano **Free**, `startCommand: node server.js`, `healthCheckPath:
   /health`. Confira e clique em **Create Web Service**.
   (Sem `render.yaml`, dá para preencher à mão: Runtime Node, Build
   Command vazio — não há dependências —, Start Command `node server.js`,
   plano **Free**.)
4. Aguarde o deploy terminar (o log mostra “proxy da Brittech Educação
   ouvindo na porta …” e “chaves configuradas: nenhuma” até a chave ser
   colocada).

### 3. Colar a chave da Maritaca como variável de ambiente

No painel do serviço, em **Environment**:

| Variável | Valor |
|---|---|
| `MARITACA_API_KEY` | a chave da Maritaca (cole aqui — ela fica só no Render) |
| `TELEGRAM_BOT_TOKEN` | o token do bot do Telegram (@BotFather) — sem ele, o bot fica inerte; com ele, o webhook se registra sozinho no restart |
| `TELEGRAM_WEBHOOK_SECRET` | (opcional) segredo do webhook, validado no cabeçalho de cada update |
| `TELEGRAM_AUTO_REGISTRO` | (opcional) `0` desliga o registro automático do webhook |
| `TELEGRAM_LIMITE_PLANOS_DIA` | (opcional) limite diário de planos/documentos por usuário (padrão: 5) |
| `TELEGRAM_LIMITE_MSGS_DIA` | (opcional) limite diário de mensagens por usuário (padrão: 30) |
| `DEEPSEEK_API_KEY` | (opcional) chave da DeepSeek, se for usar |
| `GEMINI_API_KEY` | (opcional) chave do Gemini, se for usar |
| `ALLOWED_ORIGINS` | `https://thiagollipe-web.github.io` (já vem no `render.yaml`) |

Depois de salvar, o Render reinicia o serviço sozinho. Confira no log:
“chaves configuradas: maritaca”.

> **A chave nunca vai para o GitHub, para o MVP nem para o navegador.**
> Se vazar, apague-a no painel da Maritaca e crie outra.

### 4. Apontar o MVP para o proxy

A URL do serviço aparece no topo do painel do Render, no formato
`https://brittech-proxy.onrender.com` (o nome pode variar — use a URL
exata que o Render mostrar).

No MVP, aba **Planos e IA**, cole essa URL no campo **“URL do proxy da
Brittech Educação”** e clique em **Salvar URL do proxy** — ou preencha
`proxyUrl` no `config.js`:

```js
proxyUrl: 'https://brittech-proxy.onrender.com',
```

O aviso no topo muda para **“IA real ativa via proxy”**. Teste com o
botão **Testar conexão com a IA**. Sem proxy configurado, o MVP mantém o
comportamento antigo (chamada direta + fallback para o modo demonstração).

### Atenção: o plano gratuito “dorme”

Depois de ~15 minutos sem uso, o serviço gratuito do Render desliga; a
**primeira** chamada depois disso demora ~30–60 s para “acordar” (o
primeiro plano do dia pode demorar um pouco). As chamadas seguintes são
normais. É só isso — não é erro.

## Alternativa: Cloudflare Workers (gratuito, sem servidor)

O arquivo `worker.js` faz o mesmo (mesmos endpoints e regras de CORS).
Resumo: crie um Worker no painel da Cloudflare (Workers & Pages →
Create), cole o conteúdo de `worker.js`, e crie os **secrets**
`MARITACA_API_KEY` (e `DEEPSEEK_API_KEY` / `GEMINI_API_KEY`, se usar) em
Settings → Variables (marcando “Encrypt”). A URL fica
`https://<nome>.workers.dev` — cole essa URL no campo do proxy no MVP.
Diferença para o Render: o Worker **não dorme** (responde rápido sempre),
mas o plano gratuito tem limite de requisições por dia; o Render gratuito
não tem esse limite, mas dorme após inatividade.

## Opção avançada: servidor próprio (systemd)

Só se um dia houver um servidor próprio (o Thiago não tem VPS): o
arquivo `brittech-proxy.service` é um unit systemd de exemplo. Copie a
pasta para o servidor, crie um arquivo de ambiente com as chaves (nunca
dentro do unit se ele for compartilhado), habilite com
`systemctl enable --now brittech-proxy` e coloque um Nginx na frente
(proxy reverso para a porta 8787, com HTTPS). Não é o caminho atual.

## Segurança — resumo

- Chaves **só** em variáveis de ambiente / secrets do serviço. Nunca em
  código, nunca em `config.js`, nunca no navegador, nunca no GitHub.
  Isso vale também para o token do bot do Telegram
  (`TELEGRAM_BOT_TOKEN`) — ele nunca aparece em log nem em mensagem de
  erro (os logs do bot mostram só o nome do método da Bot API e o status).
- O webhook do Telegram aceita um segredo opcional
  (`TELEGRAM_WEBHOOK_SECRET`): quando configurado, só updates com o
  cabeçalho certo são processados.
- CORS liberado só para as origens do MVP (GitHub Pages + localhost).
- Corpo limitado a 256 KB; `messages` validado (array não vazio).
- Erros da API repassados com status e mensagem curta, sem vazar a chave.
- Logs sem chave e sem conteúdo de mensagens.
