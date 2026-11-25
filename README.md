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
| `server.js` | O proxy em Node.js (só biblioteca padrão — nada para instalar). Endpoints: `POST /api/chat`, `POST /api/live-token` (conversa ao vivo), `POST /api/tts` (vozes neurais) e `GET /health`. |
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
- CORS liberado só para as origens do MVP (GitHub Pages + localhost).
- Corpo limitado a 256 KB; `messages` validado (array não vazio).
- Erros da API repassados com status e mensagem curta, sem vazar a chave.
- Logs sem chave e sem conteúdo de mensagens.
