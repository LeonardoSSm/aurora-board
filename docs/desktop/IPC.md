# Aurora Board Desktop — IPC e integrações (D1-B)

No aplicativo desktop **não existe servidor HTTP**. As integrações que na versão web passam por `/api` (servidor local `npm run server`) rodam no **processo principal** e são chamadas por IPC tipado.

## Uma lógica, dois transportes

```
            web (npm run dev)                               desktop (Electron)
 renderer ─ fetch('/api/…') ─▶ server/app.ts           renderer ─ apiFetch('/api/…') ─▶ preload ─ IPC ─▶ desktop/ipc.ts
             (Host, Origin, par TCP,                     (mesma tabela routeOp: rota → operação)   (remetente, validação,
              pareamento, Content-Type)                                                              pendentes, cancelamento)
                         ╲                                                                        ╱
                          ▶────────────── server/apiService.ts (MESMO código) ◀──────────────────
                                limites · IA · Meu Pluggy · HTML Network Bridge · links
```

- `src/integrations/apiRoutes.ts`: tabela única **rota → operação** e a allowlist do desktop.
- `server/apiService.ts`: as operações (validação de argumentos, limitadores por rota e por domínio, erros sem segredos). `server/app.ts` virou só o transporte HTTP (com as proteções de Host/Origin/pareamento); os testes de servidor existentes passam sem mudança.
- `src/integrations/apiFetch.ts`: no desktop, a mesma chamada vira `window.auroraDesktop.api.call(...)` e devolve um `Response` — IA, Meu Pluggy, pré-visualização de links e o transporte do HTML Network Bridge **não mudaram**.

## Canais

| Canal | Argumentos | Resposta |
|---|---|---|
| `aurora:api` | `callId`, `op`, `body?` | `{ status, body, retryAfter? }` |
| `aurora:api-cancel` | `callId` | — |
| `aurora:import-file` | nenhum | `{ canceled: true }`, `{ canceled: false, name, text }` ou `{ error }` |

Operações aceitas (allowlist `DESKTOP_IPC_OPS`): `health`, `ai.providers`, `ai.chat`, `linkPreview`, `pluggy.status`, `pluggy.accounts`, `pluggy.transactions`, `net.status`, `net.fetch`. Não há pareamento LAN, leitura arbitrária de arquivos, execução de comandos nem requisição genérica.

### Importação pelo menu nativo (PR #41)

`files.pickImport()` abre um diálogo de arquivo do Electron no processo principal. O IPC não aceita argumentos nem caminhos do renderer e valida o mesmo remetente das demais operações. Só um seletor pode ficar pendente. Cancelar não lê arquivos; mudar de documento durante a seleção descarta o resultado.

Somente o JSON escolhido pelo usuário é lido: arquivo regular, extensão `.json`, teto de 200 MB verificado antes de ler e durante a leitura (inclusive se crescer). A resposta contém o nome base e o texto, nunca o caminho. Erros do sistema de arquivos não atravessam o IPC. No renderer, `importFromText` mantém orçamento, schema, desativação de HTML, confirmação e gravação transacional existentes.

O menu recusa ações durante diálogos ou outra operação nativa pendente; a trava acompanha a promessa até cancelar, confirmar ou falhar. Um diálogo aberto pela interface enquanto o seletor nativo está pendente também é preservado. A importação pela barra continua usando o seletor web, disparado pelo clique do usuário.

## Validação no processo principal (`desktop/ipcValidation.ts`)

1. **Remetente:** só o **documento principal** (não um subframe) da janela do app, em `aurora://app`. O iframe dos widgets nem recebe o preload (`nodeIntegrationInSubFrames: false`) e não alcança o objeto do documento pai (origem opaca) — testado.
2. **`callId`:** `[A-Za-z0-9_-]{1,64}`, sem repetição enquanto pendente; no máximo 64 operações em andamento por janela.
3. **Operação:** da allowlist, com as chaves **exatas** (`pluggy.accounts: itemId`; `pluggy.transactions: itemId, accountId, from, to`, textos ≤ 100).
4. **Corpo:** só nas operações que o recebem (`ai.chat`, `linkPreview`, `net.fetch`); cópia JSON (sem funções, ciclos, BigInt; chaves `__proto__`/`constructor`/`prototype` descartadas); até 2 MB.
5. Depois disso, as mesmas regras da web: `validateChat`, `parseNetBody` (sem cabeçalhos/cookies/métodos de escrita), limites por minuto e concorrência, limite por domínio, SSRF/DNS no `netBridge`.

## Cancelamento e falhas

- `AbortSignal` no renderer → `aurora:api-cancel` → `AbortController` da operação (provedor de IA, Meu Pluggy, consulta do widget).
- Recarregar/navegar a janela, travar o renderer ou fechar a janela cancela todas as operações pendentes dela.
- Operação já cancelada antes de começar não chama o provedor (`499`).
- Falha inesperada no processo principal → `500 { error: 'Erro interno.' }` (sem detalhes nem conteúdo do usuário no log).

## Integrações

| Integração | No desktop |
|---|---|
| IA (OpenAI, Anthropic/Claude, Gemini) | Mesmo código de `server/providers.ts`; chaves das variáveis de ambiente do processo (D1-C: cofre do sistema operacional e tela de configuração). Sem chave: “configure a chave em Configurações do aplicativo”. Assistentes, Companions, AI Tiles, contexto autorizado e ações com confirmação são o frontend de sempre. |
| HTML Network Bridge | `aurora.request()` → corretor do host → `net.fetch` por IPC → `server/netBridge.ts` no processo principal. Autorizações locais, dados sensíveis, limites e revogação: inalterados. Homologado ao vivo (GitHub) no executável empacotado. |
| Meu Pluggy | `server/pluggy.ts` no processo principal, somente leitura; credenciais do ambiente (D1-C: cofre). |
| Pré-visualização de links | `linkPreview` com as proteções SSRF de `netSafety`. |
| Pareamento LAN | **Não existe** no desktop (nenhuma porta aberta); o botão some. |

## Testes

- `tests/unit/desktop-ipc.test.ts`: remetente (subframe/outra janela/outra origem recusados), allowlist, campos exatos, ids, corpos (onde não cabe, gigante, ciclo, BigInt, chaves de protótipo), tabela de rotas, serviço compartilhado (orientação de chave, cancelamento, limites, erro sem segredo).
- `e2e-desktop/integrations.spec.ts` (no app e no **executável empacotado**): operações da allowlist, recusas do processo principal, sem pareamento; widget → `aurora.request()` → IPC → processo principal → DNS real → erro estruturado.
- `e2e-desktop/live.spec.ts` (`AURORA_LIVE=1`, exige internet): GitHub real pelo app e autorização permanente após fechar e abrir.
