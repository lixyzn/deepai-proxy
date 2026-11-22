# DeepAI Proxy

**Proxy local compatível com a API OpenAI para contas DeepAI Code, com painel de login em vidro roxo/preto.**

> **Nota:** Este projeto foi criado para fornecer um proxy OpenAI-compatível que funciona com contas DeepAI Code, permitindo usar modelos DeepAI com o formato e as bibliotecas do OpenAI.

## Requisitos

- Node.js `>= 20.11`

## 🚀 Rodar

```bash
npm install   # não há dependências externas, mas mantém o fluxo padrão
npm start
```

Abra [`http://127.0.0.1:8790/`](http://127.0.0.1:8790/).

### Scripts

| Comando | Descrição |
|---|---|
| `npm start` | Inicia o proxy (`node src/server.mjs`) |
| `npm run dev` | Inicia com watch (`node --watch src/server.mjs`) |
| `npm run reset-password` | Remove a senha de administrador |
| `npm test` | Executa testes (`node --test`) |

## 📋 Painel (4 abas)

O painel tem quatro abas principais:

### 1. **Login** (`data-tab="login"`)

- Gere o link oficial de login e abra na página da DeepAI.
- O código retorna para `127.0.0.1` e a API key é trocada apenas uma única vez.
- O proxy **nunca vê** senha nem cookie da DeepAI (fluxo `desktop_auth`).
- Após logar, use **"Gerar link de login"** para conectar uma nova conta.
- Lista de contas conectadas com status (ativo, last check-in, allowance, entitlement Pro).

### 2. **Painel** (`data-tab="panel"`)

- **Métricas**: requisições totais, taxa de sucesso, latência média.
- **Tokens**: input/output, cache hit (percentual e tokens lidos do cache).
- **Gráficos**: requisições por hora, latência recente, modelos mais usados.
- **Saldo**: Theos e allowance da conta ativa.
- **Uso por conta**: requisições, tokens, última latência e saldo.
- **Atividade recente**: lista das últimas requisições com modelo, status e duração.

### 3. **Modelos** (`data-tab="models"`)

- Catálogo gratuito/pago/premier com logos por fabricante.
- **Busca** e **filtro por provedor** (Anthropic, Google, DeepSeek, Qwen, Zhipu, MiniMax, DeepAI, OpenAI, Outros).
- **Ordenação** por nome ou família.
- Por modelo: família, label, logo, cor e preço (Theos por request, quando disponível).
- Modelos com alias são redirecionados apenas para modelos gratuitos conhecidos (ex: `gpt-4o` → `gpt-6-luna`).
- Botão **Refresh** para recarregar do upstream (`?refresh=1`).

### 4. **Acesso** (`data-tab="access"`)

- **Base URL** do proxy (padrão: `http://127.0.0.1:8790`).
- **Token do proxy** — usado em requisições como `Authorization: Bearer $TOKEN` ou `X-Api-Key: $TOKEN`.
- **Configuração para clientes**:
  - Base URL: `http://127.0.0.1:8790/v1`
  - Qualquer modelo DeepAI pode ser usado no formato `deepai/<model-name>` ou pelo alias.
  - Para contas múltiplas, enviar header `X-DeepAI-Account: acc_...` para mudar de conta.
- **Rota de health**: `GET /health` — retorna `ok`.

## 🔐 Senha de administrador

No **primeiro acesso** o painel pede para criar a senha de administrador. Você pode:

- Clicar em **Gerar senha forte** e copiar a senha gerada; ou
- Digitar sua própria senha (mínimo de 8 caracteres).

A senha é guardada como hash `scrypt`; o proxy nunca salva a senha em texto puro. Depois de entrar, use **"Gerar link de login"** para conectar a conta DeepAI.

### Esqueceu a senha

Na tela de login do painel, clique em **"Resetar senha"**. O proxy apaga a senha atual, encerra as sessões abertas e mostra o formulário para criar uma nova senha.

Por segurança, esse botão só funciona quando o painel é acessado pelo próprio computador que roda o proxy (`127.0.0.1`). Se você acessa o painel por outro dispositivo da rede, use o comando abaixo no computador do proxy:

```bash
npm run reset-password
```

Isso remove a senha salva. Na próxima inicialização (ou ao recarregar o painel), o proxy pedirá para criar uma nova senha.

## 🌐 Usar como OpenAI

```bash
curl http://127.0.0.1:8790/v1/chat/completions \
  -H "Authorization: Bearer $DEEPAI_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "deepai/glm-5.3-flash",
    "messages": [{ "role": "user", "content": "Olá!" }]
  }'
```

O token do proxy e a base URL aparecem no painel. Para escolher uma conta específica em requisições com múltiplas contas, envie `X-DeepAI-Account: acc_...`.

### Compatibilidade OpenAI

- O proxy aceita o formato `deepai/<modelo>` (ex: `deepai/glm-5.3-flash`) e aliases de modelo (ex: `gpt-4o` → `gpt-6-luna`).
- Caso tenha mais de uma conta conectada, o proxy tenta a conta ativa e, se ela retornar `401`, `402`, `403` ou `429`, tenta a próxima automaticamente. A conta que falha entra em **cooldown** curto (60s para limite/quotas, 120s para credencial), então a próxima requisição já tenta a próxima conta.
- O header `X-DeepAI-Account` pode ser usado para selecionar conta explicitamente.

## 🧩 Cache e continuidade de contexto

O cliente OpenAI **não precisa** mandar `prompt_cache_key`, thread id ou conversation id. O proxy mantém um ledger de conversas em `data/conversations.json`:

- **Reconhece a continuação** pelo histórico normalizado, não pelo nome do modelo nem pela conta.
- Cria um `cs_...` estável por conversa e usa esse id no `prompt_cache_key` e no header `X-Session-Affinity`.
- Mantém o mesmo id quando a conta muda no failover ou o cliente troca de modelo.
- **Restaura mensagens** que o cliente compactou/truncou usando o histórico do ledger.
- Aceita `prompt_cache_key`, `conversation_id`, `thread_id`, `session_id` e headers equivalentes como **dicas** de sessão, mas não depende deles.
- O conteúdo das mensagens é guardado **criptografado** com AES-256-GCM; o painel expõe apenas metadados (ids, contagem, tamanho).

O painel tem o botão **Limpar conversas** para apagar o ledger. Sem ele, as sessões são podadas automaticamente por idade, tamanho e limite de **120 conversas**.

## 📊 Telemetria

O painel mostra:

- Requisições, taxa de sucesso, latência média e tokens (input/output).
- **Cache hit**: percentual e tokens lidos do cache.
- Gráficos de requisições por hora, latência recente e modelos mais usados.
- **Saldo de Theos** e allowance da conta ativa.
- Uso por conta: requisições, tokens, última latência e saldo.
- **Atividade recente** com detalhes por requisição.

A telemetria guarda apenas **metadados de uso**, nunca conteúdo de mensagens ou credenciais.

## 💬 Ledger de conversas

O ledger guarda o conteúdo **cifrado** em `data/conversations.json`; a chave é a mesma `data/secret.key`. O painel só mostra metadados (ids, contagem e tamanho).

- Podagem automática por idade, tamanho e limite de 120 conversas.
- O botão **Limpar conversas** no painel apaga todo o ledger.

## 🔧 Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `8790` | Porta HTTP |
| `HOST` | `127.0.0.1` | Interface de escuta |
| `DEEPAI_PROXY_DATA` | `./data` | Pasta de configuração, chaves e contas |
| `UPSTREAM_TIMEOUT_MS` | `1200000` | Tempo máximo de uma requisição ao upstream (20 min) |
| `DEEPAI_PROXY_LOCAL_TEST` | — | Se `true`, usa upstream local definido por `DEEPAI_PROXY_DEV_API_ORIGIN` |
| `DEEPAI_PROXY_DEV_API_ORIGIN` | — | Origem do upstream de teste (requer `DEEPAI_PROXY_LOCAL_TEST=true`) |

## 🧪 Testes

```bash
npm test
```

Os testes cobrem:

- Compatibilidade de payload (injeção de system, conversão `max_completion_tokens` → `max_tokens`).
- Cache de contexto (reconhecimento de continuação, compactação, restart e clear).
- Ledger de conversas (continuação, compactação, restart e clear).
- Aliases de modelo (apontam apenas para modelos gratuitos conhecidos).
- Metadados de família e logo.
- Migração da telemetria (versão 1 → versão 2).

Não fazem chamadas à DeepAI.

## 👨‍💻 Desenvolvimento

Para testar o proxy sem chamar a DeepAI de verdade, suba um upstream falso em loopback e rode:

```bash
DEEPAI_PROXY_LOCAL_TEST=true \
DEEPAI_PROXY_DEV_API_ORIGIN=http://127.0.0.1:9001 \
npm start
```

O modo local só aceita `http://127.0.0.1:<porta>`; não há como apontar para um host remoto.

### Rotas administrativas do painel (exigem sessão do painel)

- `GET /admin/api/setup` — verifica se a senha foi criada.
- `POST /admin/api/setup` — cria a senha de administrador (primeira vez).
- `POST /admin/api/login` — autentica no painel.
- `POST /admin/api/logout` — encerra a sessão do painel.
- `GET /admin/api/session` — verifica se há sessão ativa.
- `GET /admin/api/state` — estado do painel (base URL, token do proxy, contas, conta ativa, stats de conversas).
- `GET /admin/api/telemetry` — snapshot da telemetria.
- `POST /admin/api/telemetry/clear` — limpa a telemetria.
- `GET /admin/api/conversations` — metadados das sessões do ledger.
- `POST /admin/api/conversations/clear` — apaga todas as sessões do ledger.
- `GET /admin/api/models` — catálogo de modelos (`?account=acc_...`, `?refresh=1`).
- `GET /admin/api/accounts` — lista contas conectadas.
- `POST /admin/api/accounts/import` — importa uma conta via API key.
- `DELETE /admin/api/accounts/:id` — remove uma conta.
- `POST /admin/api/accounts/:id/refresh` — atualiza dados da conta.
- `POST /admin/api/accounts/:id/activate` — ativa uma conta.
- `POST /admin/api/login/start` — inicia fluxo de login `desktop_auth`.
- `GET /admin/api/login/:id` — consulta status do login.
- `POST /admin/api/login/:id/complete` — conclui login manualmente com callback/code.
- `DELETE /admin/api/login/:id` — cancela o login.
- `POST /admin/api/proxy-token/rotate` — rotaciona o token do proxy.

### Token do proxy

O proxy usa um token local para autenticar requisições à API compatível com OpenAI. O token aparece no painel e pode ser rotacionado em **Acesso**. Envie-o como `Authorization: Bearer $DEEPAI_PROXY_TOKEN` ou `X-Api-Key: $DEEPAI_PROXY_TOKEN`.

## 📁 Estrutura de dados

- `data/config.json` — configuração geral (token do proxy, hash da senha de admin, etc.).
- `data/accounts.json` — contas conectadas e metadados.
- `data/conversations.json` — ledger de conversas (conteúdo criptografado).
- `data/secret.key` — chave de criptografia AES-256-GCM usada para segredos locais.

> **Não versione a pasta `data/`** — ela contém credenciais e chaves locais.

## 🏗️ Endpoints e arquitetura

### Endpoints compatíveis com OpenAI

- `GET /v1/models` — lista modelos disponíveis.
- `GET /v1/models/:id` — detalhes de um modelo.
- `POST /v1/chat/completions` — chat completions (streaming e não-streaming).
- `POST /v1/responses` — Responses API.
- `POST /v1/audio/transcriptions` — transcrição de áudio (multipart/form-data).

### Health

- `GET /health` — retorna `{ "ok": true }`.

### Fluxo interno

1. Recebe requisições OpenAI-compatíveis.
2. Resolve aliases de modelo (somente para modelos gratuitos conhecidos) e aplica metadados de família/logo/cor.
3. Normaliza o payload (injeção de mensagem de sistema, conversão de `max_completion_tokens` para `max_tokens`, `stream_options.include_usage`, cache key).
4. Encaminha ao upstream DeepAI (ou origem local de teste).
5. Em falhas retentáveis (`401`, `402`, `403`, `429`), tenta outra conta elegível quando possível.
6. Registra telemetria e, para chat/responses, atualiza o ledger de conversas criptografado.