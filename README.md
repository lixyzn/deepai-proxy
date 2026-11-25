# DeepAI Proxy

Gateway local para usar modelos disponíveis no DeepAI Code por uma API compatível com OpenAI. Inclui uma interface web para gerenciar contas, consultar o catálogo de modelos, acompanhar requisições e configurar a chave do proxy.

> **Estado do projeto:** aplicação local em desenvolvimento. Os dados de contas e configurações ficam em arquivos JSON locais, sem criptografia em repouso. Use apenas em uma máquina confiável e não exponha o serviço à internet sem adicionar autenticação, HTTPS e controles de acesso apropriados.

## Índice

- [Recursos](#recursos)
- [Requisitos](#requisitos)
- [Instalação e execução](#instalação-e-execução)
- [Configuração](#configuração)
- [Conectar contas DeepAI](#conectar-contas-deepai)
- [Usar a API](#usar-a-api)
- [Rotação de contas](#rotação-de-contas)
- [Catálogo de modelos e logos](#catálogo-de-modelos-e-logos)
- [Gerenciamento de contexto](#gerenciamento-de-contexto)
- [Dashboard e métricas](#dashboard-e-métricas)
- [Endpoints](#endpoints)
- [Armazenamento local](#armazenamento-local)
- [Variáveis de ambiente](#variáveis-de-ambiente)
- [Solução de problemas](#solução-de-problemas)
- [Estrutura do projeto](#estrutura-do-projeto)
- [Desenvolvimento](#desenvolvimento)

## Recursos

- API de chat compatível com OpenAI em `/v1/chat/completions`.
- Listagem OpenAI-compatible de modelos em `/v1/models`.
- Suporte a respostas em streaming (SSE) e respostas JSON.
- Login DeepAI Code pelo fluxo desktop com PKCE e callback local.
- Gerenciamento de várias contas, chaves de API e cookies pelo painel.
- Seleção de conta ativa ou rotação entre contas elegíveis.
- Tentativa de failover para outra conta em erros recuperáveis, conforme a estratégia configurada.
- Catálogo de modelos carregado do DeepAI Code Desktop quando disponível, com fallback local.
- Dashboard com requisições, latência, uso de tokens, modelos e contas.
- Chave própria para proteger os endpoints do proxy.
- Interface em português, tema escuro/claro, pesquisa e filtros de modelos.
- Logos SVG locais para as famílias de modelos conhecidas; iniciais como fallback visual.
- Configuração para detectar, de forma observacional, quando o cliente já compactou o histórico.

## Requisitos

- Node.js 20 ou superior.
- Windows, macOS ou Linux. Algumas rotinas de identificação da máquina são específicas do Windows, mas possuem fallback para outros sistemas.
- Uma conta DeepAI Code ou uma credencial compatível que possa ser adicionada pelo painel.

O projeto não precisa de dependências npm de produção externas: usa módulos nativos do Node.js.

## Instalação e execução

No PowerShell:

```powershell
cd D:\deepai-proxy
npm start
```

Para desenvolvimento, com reinício automático quando os arquivos Node.js mudarem:

```powershell
npm run dev
```

Abra o painel em [http://127.0.0.1:8787](http://127.0.0.1:8787). A porta padrão da API é a mesma do painel; a base URL OpenAI-compatible será, por exemplo, `http://127.0.0.1:8787/v1`.

O servidor registra o endereço de escuta no terminal. Por padrão, `HOST` é `::` (todas as interfaces IPv6 e, normalmente, IPv4). Para limitar o acesso à própria máquina, inicie com `HOST=127.0.0.1`:

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "8787"
npm start
```

## Configuração

Abra **Configurações** no painel para:

- Consultar, copiar, substituir ou gerar novamente a chave do proxy.
- Ativar ou desativar a exigência da chave nas rotas de inferência.
- Definir a estratégia de seleção das contas.
- Escolher o modelo padrão usado quando a requisição não informa `model`.
- Ativar ou desativar a detecção de compactação feita pelo cliente.
- Consultar exemplos de uso em cURL, Node.js e Python.

A configuração é persistida em `data/config.json`. A chave é gerada na primeira inicialização. Ao rotacioná-la, a chave anterior deixa de funcionar imediatamente.

As estratégias disponíveis são:

| Estratégia | Comportamento |
| --- | --- |
| `round-robin` | Distribui chamadas entre as contas elegíveis e tenta outra conta em falhas recuperáveis. É o padrão em instalações novas. |
| `active` | Usa a conta ativa selecionada no painel; não tenta failover para outra conta. |
| `failover` | Prioriza a conta ativa em condições normais e pode tentar outras contas elegíveis quando ocorre uma falha recuperável. |

## Conectar contas DeepAI

Na aba **Contas**, escolha uma das opções disponíveis:

1. **Login DeepAI Code:** inicia o fluxo de autenticação desktop. O proxy abre um callback local e troca o código OAuth por credenciais.
2. **Importar API key:** salva uma chave informada manualmente.
3. **Importar cookie:** salva um cookie de sessão informado manualmente, quando necessário.

As contas podem ser testadas, renomeadas, ativadas/desativadas, selecionadas como ativas ou removidas. Uma conta desativada, em cooldown ou sem credencial utilizável não participa da seleção de chamadas.

O login cria um callback local em `127.0.0.1`, preferindo a porta `1455`. Se ela estiver ocupada, o programa escolhe uma porta efêmera. O fluxo expira após aproximadamente 10 minutos.

> As credenciais importadas e os tokens obtidos no login são gravados em `data/accounts.json` como JSON sem criptografia. Restrinja o acesso a essa pasta, não compartilhe esse arquivo e nunca o envie em issues, logs ou commits.

## Usar a API

Configure o cliente com a base URL terminada em `/v1` e use a chave do proxy, não a chave/cookie da conta DeepAI. A chave pode ser enviada como `Authorization: Bearer ...` ou `x-api-key`.

### cURL

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer SUA_CHAVE_DO_PROXY" \
  -d '{
    "model": "glm-5.3-flash",
    "messages": [
      {"role": "user", "content": "Olá!"}
    ],
    "stream": false
  }'
```

### Node.js

Com o pacote oficial `openai` instalado no projeto cliente:

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://127.0.0.1:8787/v1",
  apiKey: "SUA_CHAVE_DO_PROXY",
});

const completion = await client.chat.completions.create({
  model: "glm-5.3-flash",
  messages: [{ role: "user", content: "Olá!" }],
});

console.log(completion.choices[0]?.message?.content);
```

### Python

Com o pacote `openai` instalado no ambiente cliente:

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://127.0.0.1:8787/v1",
    api_key="SUA_CHAVE_DO_PROXY",
)

completion = client.chat.completions.create(
    model="glm-5.3-flash",
    messages=[{"role": "user", "content": "Olá!"}],
)

print(completion.choices[0].message.content)
```

Para streaming, envie `"stream": true` (ou `stream=True` no SDK). O proxy repassa os eventos SSE e inclui informações de uso quando disponíveis.

### Modelos

Consulte `GET /v1/models` ou a aba **Modelos** no painel. Use o `id` retornado no campo `model`. O prefixo `deepai/` também é aceito quando o cliente o envia: o proxy o remove antes de consultar o catálogo.

## Rotação de contas

O painel permite manter várias credenciais. A seleção considera apenas contas habilitadas, fora de cooldown e com credencial disponível.

Em `round-robin` e `failover`, erros de autenticação, limite de uso e erros de servidor podem colocar uma conta em cooldown e levar a uma tentativa com outra conta elegível. O comportamento depende do status retornado pelo upstream; erros de requisição do cliente não devem ser interpretados como falha da credencial.

Os períodos de cooldown são internos e podem variar por status, incluindo respostas `401`, `403`, `429` e `5xx`.

## Catálogo de modelos e logos

O proxy tenta carregar o catálogo mantido pelo DeepAI Code Desktop, nesta ordem:

1. `~/.deepai-code/userdata/deepai/pi/deepai/models.json`
2. `~/.deepai-code/caches/deepai.json`

O catálogo é observado em busca de alterações, permitindo que novos modelos apareçam sem reiniciar o proxy. Para fixar outro arquivo, defina `DEEPAI_MODELS_FILE`. Se nenhum catálogo válido for encontrado, é usada a lista estática em `src/models.mjs`.

As logos usadas pelo painel são SVGs locais em `public/logos/`. O mapeamento de família fica em `MODEL_LOGOS` no `public/app.js`; modelos sem correspondência exibem as iniciais do provedor. As logos são carregadas como máscaras CSS para se adaptarem às cores dos cards e funcionarem nos temas escuro e claro.

## Gerenciamento de contexto

O modo atual é **pass-through**: o proxy não remove mensagens, não trunca histórico e não compacta o contexto. Ele encaminha o conteúdo recebido, aplicando apenas normalizações necessárias para compatibilidade do protocolo.

O proxy estima tokens de entrada para telemetria. Essa estimativa é aproximada, não substitui o contador oficial do modelo e não é usada para podar o histórico. Quando a detecção está ativada, o proxy registra sinais de compactação já feita pelo cliente e informa isso nas métricas e cabeçalhos de resposta.

## Dashboard e métricas

O dashboard mostra indicadores e séries temporais por período, distribuição por modelo e conta e requisições recentes. O painel atualiza os dados automaticamente a cada 15 segundos por padrão; esse comportamento pode ser desligado no controle **Auto**.

As métricas ficam em `data/metrics.json`; a lista de requisições armazenada é limitada aos registros mais recentes. O botão de reset do painel apaga as métricas registradas, mas não remove contas ou configurações.

## Endpoints

### Compatibilidade OpenAI

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/v1/models` | Lista os modelos em formato OpenAI-compatible. |
| `GET` | `/models` | Alias de `/v1/models`. |
| `POST` | `/v1/chat/completions` | Cria uma conversa; aceita streaming SSE. |
| `POST` | `/chat/completions` | Alias de `/v1/chat/completions`. |

As rotas de inferência exigem a chave do proxy por padrão. Envie-a no header `Authorization: Bearer <chave>` ou `x-api-key: <chave>`. A opção de desativar a exigência está disponível nas configurações.

### API do painel

| Método | Rota | Descrição |
| --- | --- | --- |
| `GET` | `/api/health` ou `/healthz` | Estado do serviço e contagem de contas. |
| `GET` | `/api/config` | Lê as configurações locais. |
| `PUT` | `/api/config` | Atualiza opções como estratégia, modelo padrão, chave e contexto. |
| `POST` | `/api/config/rotate-key` | Gera uma nova chave do proxy. |
| `GET` | `/api/accounts` | Lista contas com segredos mascarados. |
| `GET` | `/api/accounts/active` | Retorna a conta ativa. |
| `POST` | `/api/accounts/select` | Seleciona uma conta ativa (`{ "id": "..." }`). |
| `POST` | `/api/accounts/import-key` | Importa uma API key (`apiKey`, opcionalmente `label`, `username`, `isPro`). |
| `POST` | `/api/accounts/import-cookie` | Importa um cookie (`cookie`, opcionalmente `label`). |
| `POST` | `/api/accounts/:id/test` | Testa a credencial de uma conta. |
| `PATCH` | `/api/accounts/:id` | Atualiza o nome ou o estado habilitado da conta. |
| `DELETE` | `/api/accounts/:id` | Remove uma conta. |
| `GET` | `/api/auth/status` | Consulta o estado atual do login. |
| `POST` | `/api/auth/login` | Inicia login; body opcional: `{ "label": "Minha conta" }`. |
| `POST` | `/api/auth/cancel` | Cancela login pendente; pode receber `id` ou `loginId`. |
| `POST` | `/api/auth/submit` | Envia manualmente código, state ou URL de callback. |
| `GET` | `/api/models` | Retorna o catálogo para o dashboard; aceita `tier` e `search`. |
| `GET` | `/api/models/catalog` | Força a atualização do catálogo do desktop. |
| `GET` | `/api/metrics` | Retorna métricas; aceita `range` (`1h`, `6h`, `24h`, `7d`, `30d`, `all`). |
| `POST` | `/api/metrics/reset` | Limpa as métricas locais. |

> As rotas `/api/*` e o painel não têm autenticação própria. Por padrão o servidor escuta em todas as interfaces; defina `HOST=127.0.0.1` para uso estritamente local. O CORS do servidor é aberto, portanto não exponha a interface sem proteção adicional.

## Armazenamento local

Os arquivos abaixo são criados automaticamente e estão ignorados pelo Git:

| Arquivo | Conteúdo |
| --- | --- |
| `data/accounts.json` | Contas e credenciais locais. **Contém segredos em texto puro.** |
| `data/config.json` | Chave do proxy e opções da aplicação. |
| `data/metrics.json` | Totais e requisições usados pelo dashboard. |

Faça backup apenas em local seguro. Para migrar ou compartilhar o projeto, não copie `data/accounts.json` nem publique chaves, cookies ou tokens. A remoção desses arquivos é irreversível se não houver backup.

## Variáveis de ambiente

| Variável | Padrão | Descrição |
| --- | --- | --- |
| `HOST` | `::` | Interface de rede em que o servidor local escuta. Use `127.0.0.1` para limitar ao loopback. |
| `PORT` | `8787` | Porta do painel e da API. |
| `DEEPAI_ORIGIN` | `https://api.deepai.org` | Origem dos endpoints DeepAI de autenticação e API. |
| `DEEPAI_MODEL_BASE` | `${DEEPAI_ORIGIN}/deepai_code` | Base do upstream de inferência; útil para ambientes compatíveis/testes. |
| `DEEPAI_LOGIN_PORT` | `1455` | Porta preferida para callback local do login; usa porta efêmera se estiver ocupada. |
| `DEEPAI_MODELS_FILE` | descoberta automática | Caminho absoluto para fixar um arquivo de catálogo de modelos. |

Exemplo de execução com variáveis temporárias no PowerShell:

```powershell
$env:HOST = "127.0.0.1"
$env:PORT = "8787"
npm start
```

## Solução de problemas

### O painel não abre

- Confirme no terminal se o servidor iniciou e em qual porta está escutando.
- Verifique se outra aplicação já está usando a porta configurada; altere `PORT` se necessário.
- Se quiser acesso apenas local, confira se `HOST` está em `127.0.0.1`.

### A API responde `401`

- Confirme se a chave enviada é a **chave do proxy**, configurada no painel, não a credencial DeepAI.
- Use `Authorization: Bearer <chave>` ou `x-api-key: <chave>`.
- Se a chave foi rotacionada, atualize todos os clientes.

### Nenhuma conta está disponível

- Adicione uma conta ou uma credencial válida na aba **Contas**.
- Verifique se a conta está habilitada e fora de cooldown.
- Use **Testar** para verificar a credencial.

### O catálogo não carrega ou está desatualizado

- Confirme que o DeepAI Code Desktop criou um dos arquivos de catálogo reconhecidos.
- Consulte `/api/models` para ver a origem e a quantidade carregada.
- Defina `DEEPAI_MODELS_FILE` para apontar explicitamente ao arquivo correto ou use `GET /api/models/catalog` para forçar a leitura.
- Sem um catálogo local válido, o proxy usa a lista estática embutida.

### O login não conclui

- Mantenha o proxy em execução durante o login.
- Permita a conexão local ao callback em `127.0.0.1`.
- A porta padrão é `1455`; se ocupada, o sistema tenta uma porta efêmera.
- O link expira em cerca de 10 minutos; inicie outro login se necessário.

## Estrutura do projeto

```text
deepai-proxy/
├── index.mjs                 # Entrada do servidor
├── package.json              # Scripts e requisito de Node.js
├── README.md
├── data/                     # Dados locais ignorados pelo Git
├── docs/
│   ├── deepai-context-protocol.md
│   └── deepai-protocol.md
├── public/
│   ├── index.html            # Interface do painel
│   ├── styles.css            # Design responsivo e temas
│   ├── app.js                # Lógica de interação do painel
│   └── logos/                # Logos SVG locais dos provedores/modelos
└── src/
    ├── auth.mjs              # Login desktop, PKCE e callback
    ├── config.mjs            # Configuração e autenticação da chave do proxy
    ├── context.mjs           # Compatibilidade e telemetria de contexto
    ├── deepai.mjs            # Chamadas de autenticação e upstream DeepAI
    ├── metrics.mjs           # Registro e agregação de métricas
    ├── models.mjs            # Catálogo local/estático de modelos
    ├── proxy.mjs             # Chat completions, streaming e failover
    ├── server.mjs            # Servidor HTTP, API e arquivos estáticos
    └── store.mjs             # Persistência e seleção de contas
```

## Desenvolvimento

```powershell
npm run dev
```

Verificações rápidas de sintaxe:

```powershell
node --check .\index.mjs
node --check .\src\server.mjs
node --check .\public\app.js
```

Os documentos em `docs/` descrevem detalhes observados do protocolo DeepAI. O README não substitui esses documentos nem garante estabilidade do protocolo de terceiros.
