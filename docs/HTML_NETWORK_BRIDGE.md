# HTML Network Bridge — ciclo H2

Widgets **HTML isolado** podem consultar APIs HTTPS externas **autorizadas** com `aurora.request()`, sem perder o isolamento: o iframe continua `sandbox="allow-scripts"`, sem `allow-same-origin`, com a CSP `default-src 'none'` (sem rede própria). Quem consulta é o **servidor local**, e só depois de o **host** (a origem do app) conferir a autorização do usuário e a política de dados sensíveis.

> Estado: **H2-A** — protocolo, autorizações e política de dados sensíveis. O transporte remoto ainda está **inativo** (`aurora.request()` responde `unavailable`); os testes usam um transporte simulado. H2-B entrega o transporte HTTP seguro; H2-C, o painel “Acesso à rede”, exemplos e a documentação completa.

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

`unavailable`, `invalid_request`, `headers_not_allowed`, `method_not_allowed`, `invalid_url`, `blocked_url`, `blocked_address`, `permission_denied`, `sensitive_blocked`, `too_many_pending`, `rate_limited`, `timeout`, `aborted`, `revoked`, `unmounted`, `network_error`, `dns_error`, `redirect_blocked`, `http_error`, `invalid_json`, `unsupported_content_type`, `invalid_encoding`, `response_too_large`, `local_only`.

## Fronteiras de confiança (resumo H2-A)

| Camada | Garante |
|---|---|
| iframe (não confiável) | Nada: só pede. Sem rede própria (CSP), sem WebRTC. |
| Host (origem do app) | Origem da mensagem, token, limites por iframe, **autorização do usuário**, **política de dados sensíveis**, cancelamento e revogação. |
| Servidor local (H2-B) | Regras de rede independentes do frontend (HTTPS/443, SSRF, DNS, tamanho, tempo, tipos). |

## Testes

- `tests/unit/net-bridge.test.ts`: protocolo (padrões, cabeçalhos, métodos, esquemas, IPs, nomes locais), conferência das respostas, política (fontes a montante, Fórmula/IA, chaves, sensível, fonte excluída), corretor (indisponível, permitir sempre/uma vez, negar, simultâneas, tokens/IDs, limites, revogação durante a consulta, edição/conexão durante a consulta, desmontagem, tempo, cancelamento, erros), backups/importação.
- `e2e/net-bridge.spec.ts`: confirmação → resposta no HTML; negar; indisponível sem transporte; `fetch` direto bloqueado; cabeçalhos recusados; mensagens forjadas ignoradas.
