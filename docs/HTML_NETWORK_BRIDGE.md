# HTML Network Bridge — ciclo H2

Widgets **HTML isolado** podem consultar APIs HTTPS externas **autorizadas** com `aurora.request()`, sem perder o isolamento: o iframe continua `sandbox="allow-scripts"`, sem `allow-same-origin`, com a CSP `default-src 'none'` (sem rede própria). Quem consulta é o **servidor local**, e só depois de o **host** (a origem do app) conferir a autorização do usuário e a política de dados sensíveis.

Ciclo H2 (issue #30): **H2-A** protocolo, autorizações e dados sensíveis (PR #31) · **H2-B** transporte HTTP seguro (PR #32) · **H2-C** painel, exemplos, E2E e documentação (PR #33). Modelo de ameaça: [docs/security/H2-NETWORK-THREAT-MODEL.md](security/H2-NETWORK-THREAT-MODEL.md).

## Motivação e objetivos

Dashboards HTML ficavam limitados aos dados do próprio quadro. O H2 permite que eles consultem APIs públicas (cotações, clima, repositórios, status de serviços) e se atualizem — **sem** dar rede ao iframe. Objetivos:

1. O HTML continua isolado (sem `allow-same-origin`, sem `connect-src`, sem WebRTC); só **pede**.
2. Nada sai sem o usuário autorizar o **destino** para **aquele bloco**; a autorização é local e não viaja em quadros/backups.
3. Dados protegidos (banco, Meu Pluggy, Data Hub, finanças e derivados) não saem por causa de uma autorização genérica.
4. O servidor local impõe sozinho as regras de rede (SSRF, DNS rebinding, tamanho, tempo, tipos).
5. O build público continua sem rede e sem rotas internas.
6. Base reutilizável: um app desktop futuro troca só o transporte (ver Compatibilidade).

## Arquitetura

```
public/sandbox.html (iframe)        src/widgets/builtin/sandbox.tsx       src/net/broker.ts (host)
 aurora.request() ──postMessage──▶  SandboxFrame: event.source + token ─▶ NetSession: valida, limita, política
                                                                          │  src/net/policy.ts (pura): chaves, fontes
                                                                          │  src/net/consent.tsx: confirmação
                                                                          │  src/net/grants.ts: htmlNetGrants (kv local)
                                                                          ▼
                                    src/net/transport.ts ── POST /api/net/fetch ──▶ server/app.ts ─▶ server/netBridge.ts
                                                                                                     └ server/netSafety.ts
 aurora:response ◀──postMessage── revalida (revogação/desmontagem) ◀──────────── resultado estruturado
```

`src/net/protocol.ts` é puro e usado dos dois lados (mesmas regras de URL e códigos de erro). O painel é `src/net/NetAccessPanel.tsx`.

## API no HTML

```js
const r = await aurora.request({
  url: 'https://api.github.com/repos/LeonardoSSm/aurora-board',
  method: 'GET',            // padrão; único método da v1
  responseType: 'json',     // 'json' (padrão) ou 'text'
  timeoutMs: 10000,         // 1 000–20 000 (padrão 10 000)
  signal,                   // AbortSignal opcional (cancelamento)
});
r.data.stargazers_count;    // { ok, status, url, contentType, bytes, data | text }
```

- Rejeita com `AuroraRequestError` (`e.code`, `e.message`, e `e.status`/`e.data`/`e.text` em `http_error`).
- `aurora.network` → `{ version: 1, available, message }` (disponibilidade nesta versão).
- `aurora.inputs`, `aurora.onInputs`, `aurora.publish`, `aurora.state` e `aurora.setState` não mudam.
- Não aceita `headers`, `credentials`, `mode`, `body` nem métodos além de GET. O host define cabeçalhos seguros; nenhum cookie, `Authorization`, token bancário, chave de IA ou dado interno é encaminhado.

### Protocolo (retrocompatível com o H1)

```
iframe → host: { type: 'aurora:request', token, id, url, method, responseType, timeoutMs? }
               { type: 'aurora:abort',   token, id }
host → iframe: { type: 'aurora:load', …, net: { v: 1, token, available, message } }      (token também sem portas)
               { type: 'aurora:response', token, id, ok: true,  result }
               { type: 'aurora:response', token, id, ok: false, error: { code, message, status?, data?, text? } }
```

O host só aceita mensagens da janela do PRÓPRIO iframe (`event.source`) com o `token` da montagem atual. IDs repetidos (pendentes ou já respondidos) e mensagens malformadas são descartados; mensagens de montagens anteriores, de outro frame ou da página não têm efeito. Cada consulta recebe exatamente uma resposta.

## Modelo de permissões

Rede **desligada por padrão**. Na primeira consulta a uma origem ainda não autorizada, o app mostra uma confirmação com: nome do bloco, destino (origem), método, tipo de informação e o aviso de que o endereço consultado pode carregar dados recebidos de outros blocos (entradas conectadas listadas). Opções: **Negar**, **Permitir uma vez**, **Permitir sempre neste dispositivo**.

| Escolha | Vale para |
|---|---|
| Negar | Esta execução do bloco (não pergunta de novo até ele ser recarregado). Fechar a janela recusa só as consultas pendentes. |
| Permitir uma vez | Esta execução do bloco (montagem do iframe). Recarregar, editar, rolar para fora da vista e voltar, trocar de quadro: pergunta de novo. |
| Permitir sempre | Este navegador, este bloco, esta origem, GET, esta configuração. |

Consultas simultâneas do mesmo bloco para o mesmo destino esperam **uma** confirmação. Só uma janela aparece por vez (fila única); se o bloco desmonta, a janela fecha sozinha.

### Fluxo de consentimento

1. O HTML chama `aurora.request()`; o iframe posta `aurora:request` com o token da montagem.
2. O host confere janela de origem, token, id, limites e a URL.
3. Calcula a decisão: `allowed` (já autorizado), `prompt` (comum ou **sensível**), `denied` (negado nesta execução) ou `blocked` (fonte protegida não verificável).
4. `prompt` entra na fila única de confirmações (pedidos iguais são agrupados); a janela aparece quando nenhuma outra janela do app estiver aberta.
5. A resposta vira concessão (“uma vez” na sessão do iframe, “sempre” em `htmlNetGrants`) ou negação; a decisão é **recalculada** (o bloco pode ter mudado com a janela aberta).
6. A consulta espera vaga (4 simultâneas) e é **revalidada imediatamente antes do envio**.
7. O transporte chama o servidor local; a resposta é revalidada (revogação, edição, desmontagem) e conferida antes de ir ao iframe.

### Onde fica e o que invalida

- Configuração local `htmlNetGrants` (IndexedDB `aurora-board`, área `kv`): **fora** do JSON do quadro, dos backups e das exportações. Separada das autorizações de IA (`htmlAiGrants`, `datasetAiGrants`, `aiGrants` do razão).
- A chave cobre: id do bloco, **quadro**, **marca de ativação** (HTML importado/colado recebe uma nova a cada importação — importar e duplicar nunca herdam), **resumo do HTML**, **conexões de entrada**, **origem** e **método**. Mudar qualquer um invalida; a consulta pendente é cancelada (`revoked`).
- Permissões declaradas no HTML, no estado do bloco ou em arquivos importados são ignoradas (não há campo que as leia).
- Revogar (`revokeNetAccess`) remove as concessões persistentes e as “uma vez”, e cancela consultas em andamento.

## Dados sensíveis (exfiltração)

Um bloco que recebe dados protegidos **não** consulta a rede só com a autorização comum. É preciso uma autorização **adicional e específica** (`kind: 'sensitive'`), que lista as fontes e o destino.

- **Fontes protegidas:** Consulta bancária (contas bancárias e Meu Pluggy), Dados importados (Data Hub) e Finanças (lançamentos).
- **Derivados:** o percurso segue conexões de dados a montante (Fórmula, Mês, outro HTML) e, num **Assistente IA**, tudo o que ele lê — a resposta da IA deriva do contexto. Autorização para IA **não** conta como autorização para enviar a uma API.
- **Memória do iframe:** uma fonte que alimentou a execução atual continua contando até o bloco ser recarregado, mesmo se a conexão for removida (o HTML pode ter guardado os dados).
- **HTML a montante:** um bloco HTML que alimenta este carrega o que guardou — a marca do estado dele e as fontes que já alimentaram a execução dele nesta página (as saídas publicadas sobrevivem à desmontagem). Fonte lembrada que não existe mais bloqueia.
- **Estado gravado:** `setState` feito por uma execução com dados protegidos marca o bloco (`stateTaint`, só restringe). Enquanto a marca existir, a rede exige a autorização específica daquelas fontes.
- **Fonte que não existe mais** (excluída, ou marca ilegível): não há como identificar a origem dos dados — a consulta é **bloqueada** (`sensitive_blocked`) com o motivo. Não há bypass: limpe o estado e recarregue o bloco.
- A autorização específica cobre id, tipo e configuração de cada fonte (consulta: ledger, contas, métrica, período…; dados importados: arquivo e visão). Mudar a fonte invalida só ela.

## Revogação

- Painel **Acesso à rede** → **Revogar** (um destino) ou **Revogar acesso / Revogar todos os acessos** (o bloco inteiro).
- Revogar remove concessões persistentes **e** “uma vez”, cancela consultas na fila e em andamento (o servidor aborta a consulta externa quando o app fecha a conexão) e descarta respostas que cheguem depois (`revoked`).
- Mudar o HTML, as conexões de entrada, as fontes protegidas ou o quadro, ou importar/colar o bloco, também invalida (a concessão antiga aparece como “desatualizada” no painel).

## Painel “Acesso à rede”

Na seção **Acesso à rede** das Propriedades de todo bloco HTML isolado:

- **Estado:** desativado, aguardando autorização, autorizado, bloqueado (fonte protegida não verificável) ou indisponível (versão sem backend).
- **Destinos:** origem, método (GET), “sempre neste dispositivo” (com data) e/ou “uma vez (esta execução)”, fontes protegidas autorizadas, aviso de concessão desatualizada; revogar individual e todos.
- **Última consulta:** status HTTP ou código de erro, domínio, tamanho, duração e horário — **nunca** o caminho, a consulta ou o corpo.
- **Bloqueadas:** contagem e último motivo.
- **Dados protegidos:** fontes que alimentam (ou alimentaram) o bloco; **Limpar estado e recarregar** apaga o estado gravado e a marca, esquece a memória/saídas da execução e remonta o iframe.
- Avisos: build sem backend de rede, servidor local fora do ar ou desatualizado, computador pareado (só o principal consulta).
- Funciona com a lateral na largura mínima (220 px) — testado.

## Exemplos

**Dashboard público (GitHub)** — Propriedades → Exemplos editáveis → “Dashboard público: repositório do GitHub (aurora.request)”. Consulta `https://api.github.com/repos/<dono>/<nome>` (GET público, sem chave), mostra estrelas, forks, issues abertas e descrição, publica a saída `estrelas` (número) para Fórmula/Gráfico e tem o botão **Atualizar**. Não consulta nada ao abrir ou importar: só ao clicar.

```html
<button id="go">Atualizar</button> <b id="stars">—</b> <span id="err"></span>
<script>
  let ctrl;
  document.getElementById('go').onclick = async () => {
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    try {
      const r = await aurora.request({ url: 'https://api.github.com/repos/LeonardoSSm/aurora-board', signal: ctrl.signal });
      document.getElementById('stars').textContent = r.data.stargazers_count;
    } catch (e) {
      if (e.code !== 'aborted') document.getElementById('err').textContent = e.code + ': ' + e.message;
    }
  };
</script>
```

Texto: `aurora.request({ url, responseType: 'text' })` → `r.text`. Erro da API: `e.code === 'http_error'`, `e.status`, `e.data` (JSON) ou `e.text`.

## Limites (host)

| Limite | Valor |
|---|---|
| URL | 2 048 caracteres, `https:`, porta 443, sem usuário/senha, sem IP literal, sem nomes locais (`localhost`, `.local`, `.internal`, `.test`…) |
| Tempo | 10 s padrão, 1–20 s |
| Pendentes por iframe | 8 (`too_many_pending`) |
| Por minuto por iframe | 30 (`rate_limited`) |
| Simultâneas no total | 4 (as demais esperam na fila; a vaga volta mesmo se o transporte travar) |
| Mensagens de rede por segundo por iframe | 50 (excedentes descartadas) |
| Resposta | 1 MB (`response_too_large`) |

## Erros

| Código | Quando |
|---|---|
| `unavailable` | Build público, transporte desligado ou servidor local sem a rota |
| `local_only` | Computador pareado: só o principal consulta |
| `invalid_request` | Opção desconhecida, `responseType`/`timeoutMs` inválidos |
| `headers_not_allowed` | `headers`, `credentials`, `mode`, cookies/`Authorization` |
| `method_not_allowed` | Método ≠ GET ou `body` |
| `invalid_url` / `blocked_url` | URL malformada / esquema, porta, IP literal, credenciais ou nome local |
| `blocked_address` | O domínio resolveu (ou conectou) para endereço local/reservado |
| `dns_error` | Domínio não encontrado |
| `permission_denied` | Usuário negou (ou fechou a janela) |
| `sensitive_blocked` | Dados protegidos de fonte não verificável (excluída) |
| `too_many_pending` / `rate_limited` | Limites do bloco, do servidor ou do domínio |
| `timeout` / `aborted` | Tempo esgotado / `signal` ou `aurora:abort` |
| `revoked` | Autorização revogada ou desatualizada antes/durante a consulta |
| `unmounted` | Bloco fechado, excluído ou em outro quadro |
| `redirect_blocked` | A API respondeu 3xx (use o endereço final) |
| `http_error` | Status ≠ 2xx (`status`, `data` ou `text` anexos) |
| `invalid_json` | JSON inválido ou com mais de 64 níveis |
| `unsupported_content_type` / `invalid_encoding` | Binário/tipo não permitido / charset ≠ UTF-8, UTF-8 inválido, compressão |
| `response_too_large` | Mais de 1 MB |
| `network_error` | Falha de conexão ou do servidor local |

## Fronteiras de confiança

| Camada | Garante |
|---|---|
| iframe (não confiável) | Nada: só pede. Sem rede própria (CSP), sem WebRTC. |
| Host (origem do app) | Origem da mensagem, token, limites por iframe, **autorização do usuário**, **política de dados sensíveis**, cancelamento e revogação. |
| Servidor local (`server/netBridge.ts`) | Regras de rede **independentes do frontend**: GET, HTTPS/443, sem IP literal/nomes locais, DNS validado na conexão, IP conectado conferido, sem redirecionamentos, tempo, tamanho, tipos, limites por minuto/domínio/concorrência, só o computador principal. |

O servidor **não** conhece as autorizações do usuário: elas vivem no IndexedDB da origem do app (como as de IA) e são conferidas pelo host. O que o backend garante sozinho é que, mesmo chamado diretamente (por exemplo, por um processo local ou um app alterado), ele só faz GETs HTTPS a destinos públicos, sem repassar nada do navegador. Quem pode chamar a rota: só o próprio computador (par TCP loopback, `Host` e `Origin` locais — o iframe tem `Origin: null` e é recusado), nunca um dispositivo pareado (`local_only`).

## Transporte (servidor local)

`POST /api/net/fetch` com `{ url, method: 'GET', responseType, timeoutMs }` (chaves exatas; `headers`, `cookie`, `authorization`… → `headers_not_allowed`). `GET /api/net/status` informa disponibilidade e limites.

| Regra | Como |
|---|---|
| Destino | `https:`, porta 443, sem usuário/senha, sem IP literal, sem nomes locais — validado de novo no servidor |
| SSRF / DNS rebinding | DNS resolvido **dentro** da conexão (`lookup` seguro); **todos** os endereços conferidos; o IP do socket conectado é conferido de novo; conexão nova por consulta (sem pool) |
| Endereços bloqueados | loopback, `0.0.0.0/8`, privados (RFC 1918), CGNAT, link-local (inclui `169.254.169.254`), multicast, reservados, documentação; IPv6 `::/96` (IPv4 compatível), `::1`, IPv4 mapeado, NAT64 (`64:ff9b::/96`, `64:ff9b:1::/48`), 6to4, Teredo/`2001::/23`, ULA (`fc00::/7`, inclui `fd00:ec2::254`), link-local, multicast |
| Redirecionamentos | **não** seguidos (`redirect_blocked`, sem revelar o destino) |
| Cabeçalhos enviados | só `Accept`, `Accept-Encoding: identity` e `User-Agent` fixos. Cookies, `Authorization` e o token de dispositivo pareado nunca são repassados |
| Resposta | até 1 MB (inclusive `Content-Length` declarado); sem compressão; JSON (`application/json`, `+json`) ou texto (`text/*`, XML, NDJSON); binário (bytes nulos, `image/*`, `octet-stream`), `application/javascript`, charsets ≠ UTF-8 e UTF-8 inválido recusados; BOM removido; JSON com no máximo 64 níveis |
| Tempo | total (conexão + cabeçalhos + corpo) = `timeoutMs` |
| Cancelamento | o app fecha a conexão (desmontagem, revogação, `aurora:abort`) → a consulta externa é abortada |
| Limites | 120/min no total, 6 simultâneas, 60/min por domínio (`429` estruturado) |
| Erros e logs | mensagens sem segredos e sem a URL; nenhum log por consulta |

Build público: sem servidor — `aurora.request()` responde `unavailable` sem confirmar nada; a rota nem existe no pacote (constante de build `LOCAL_API_ENABLED`).

## Compatibilidade

- **Modo local atual** (`npm run dev`, ou build com `VITE_AURORA_LOCAL_API=1` + `npm run server:start`): rede disponível no computador principal.
- **Build público estático** (`npm run build`): `aurora.request()` → `unavailable` sem confirmação; o transporte e a rota não existem no pacote; nenhuma consulta ao abrir ou importar quadros; CSP do site e do sandbox inalteradas (E2E `static`).
- **Computador pareado (LAN):** `local_only` (a rota recusa chamadas remotas mesmo com token válido).
- **HTML antigo:** nada muda; `aurora.request` é só uma função nova. Blocos sem portas recebem o token pela mensagem `net` do `aurora:load`.
- **App desktop futuro (D1):** o corretor recebe o transporte por `setNetTransport` — um processo principal (Electron/Tauri) pode oferecer o mesmo contrato `NetRequest → NetOutcome` por IPC reaproveitando `server/netBridge.ts`; política, autorizações e painel não mudam.

## Restrições conhecidas

Ver [KNOWN_ISSUES.md › HTML Network Bridge](KNOWN_ISSUES.md#html-network-bridge-ciclo-h2-issue-30): só GET/HTTPS/443, JSON ou texto UTF-8 até 1 MB, sem redirecionamentos, cabeçalhos próprios, chaves de API, POST, WebSocket ou OAuth; “uma vez” cai ao rolar o bloco para fora da vista; editar HTML/conexões pede de novo; canal por URL depois de autorizado.

## Diagnóstico

1. **Painel Acesso à rede**: estado, último erro e bloqueios dizem em qual camada parou.
2. `aurora.network` no HTML: `available: false` → versão sem backend (ou bloco de terceiros).
3. `unavailable`/`network_error` em modo local: o servidor está rodando? `curl http://127.0.0.1:8787/api/net/status` deve responder `{"available":true,…}` (`404` = servidor antigo).
4. `blocked_address`/`dns_error`: o domínio resolve para rede local/reservada (ou não existe) — o servidor não conecta, por design.
5. `redirect_blocked`: use a URL final (com/sem `www`, barra final).
6. `unsupported_content_type`/`invalid_encoding`: a API devolve binário, outro charset ou comprime ignorando `identity`.
7. Pede de novo a cada vez: o HTML ou as conexões mudaram (concessão “desatualizada”), ou foi “uma vez” e o bloco remontou.
8. Dados protegidos: veja “Recebe dados protegidos” no painel; `sensitive_blocked` → **Limpar estado e recarregar**.
9. O servidor não registra consultas (nem URLs), e o console do app também não. Para depurar um HTML, trate `e.code` no próprio HTML.

## Testes

- `tests/unit/net-bridge.test.ts`: protocolo (padrões, cabeçalhos, métodos, esquemas, IPs, nomes locais), conferência das respostas, política (fontes a montante, Fórmula/IA, chaves, sensível, fonte excluída), corretor (indisponível, permitir sempre/uma vez, negar, simultâneas, tokens/IDs, limites, revogação durante a consulta, edição/conexão durante a consulta, desmontagem, tempo, cancelamento, erros), backups/importação.
- `tests/unit/net-server.test.ts`: corpo da rota; 23 endereços proibidos (antes de conectar); lista mista; DNS rebinding; IP conectado; DNS inexistente; redirecionamento; **transporte real** com DNS injetado para loopback (nenhuma conexão); JSON/texto e cabeçalhos enviados; 404/500/JSON inválido/vazio; gigantes; binário/charset/UTF-8/compressão/profundidade; tempo e cancelamento; rota: `Origin: null`, site externo, `Host` forjado, par de fora, dispositivo pareado (`local_only`), 400/415, limites por minuto e por domínio, cliente que desiste cancela a consulta.
- `e2e/net-panel.spec.ts` (H2-C): painel (estado, destino, GET, última consulta sem caminho/consulta, revogar um/todos, “uma vez”, bloqueios); banco conectado → confirmação específica e negação; exemplo GitHub (nada ao abrir, Atualizar, KPIs, saída publicada); excluir com a confirmação aberta; consulta pendente não chega a bloco novo; estado marcado + fonte excluída → bloqueado → Limpar estado; painel em 220 px.
- `e2e/static/public-build.spec.ts`: no build público, `aurora.request()` → `unavailable`, sem confirmação e sem rede.
- `e2e/net-bridge.spec.ts`: confirmação → resposta no HTML; negar; indisponível sem transporte; `fetch` direto bloqueado; cabeçalhos recusados; mensagens forjadas ignoradas; transporte do app para `/api/net/fetch` (corpo exato) e o servidor real recusando destinos internos.
