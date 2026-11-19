# S1 — Segunda auditoria interna e matriz final (Etapa 14)

Revisão do diff completo `709f0dc..security/public-beta-hardening-s1` depois das correções, procurando
formas de contornar cada controle novo — e não apenas confirmando que os testes passam.

## Procedimento

1. Diff completo revisado por área (documentos, importação, sandbox, mídias, frontend, servidor, CSP, CI).
2. Para cada controle: "qual entrada chega ao mesmo destino por outro caminho?".
3. Build de produção inspecionado (`dist/`): sem `__aurora`, sem `/api`, sem source maps, sem chaves; CSP em `<meta>`.
4. Dependências reavaliadas (`npm audit`: 0).
5. Preservação de dados conferida: nenhuma migração destrutiva; importação nunca sobrescreve; assets recusados
   na exibição continuam armazenados.

## Achados novos da segunda auditoria (no código do próprio ciclo)

| ID | Contorno encontrado | Correção | Teste |
|---|---|---|---|
| S1-SEC-019 | Prévia de SVG em Documentos usava `blob:` da origem: "abrir imagem em nova aba" renderizaria o SVG como documento ativo (dev: sem CSP) | SVG via `data:` (navegação de topo para `data:` é bloqueada; origem opaca) | E2E "SVG com script…" (abre a imagem numa aba) |
| S1-SEC-020 | Importação **legada** não passava pelos tetos de elementos após a conversão | Mesmos tetos por quadro e totais | `import-hardening.test.ts` |
| S1-SEC-021 | Colagem externa não aplicava o orçamento (profundidade) — dados aninhados quebrariam o salvamento | `checkImportBudget` na colagem | E2E "colagem externa com dados aninhados" |
| S1-SEC-022 | JPEG com EXIF longo: marcador de dimensões além dos 256 KB lidos contornava o limite de "bomba" | Segunda leitura até 4 MB quando as dimensões não aparecem | revisão de código + testes de dimensões |

Também encontrado pela CI (não por mim): o E2E principal coletava `e2e/static/` contra o dev server — corrigido
na configuração (`a672117`); e, no Firefox, navegação bloqueada pela CSP não gera segundo `load` — o teste passou a
afirmar a propriedade de segurança (o frame não alcança o destino) em vez de um detalhe de UI (`c9a2519`).

## Tentativas de contorno avaliadas e sem sucesso

| Tentativa | Resultado |
|---|---|
| Backup declara o widget HTML como `activation: allowed` | Sobrescrito pelo importador (teste unitário e E2E) |
| Widget HTML por colagem, legado, duplicação de quadro, proposta de IA | Colagem externa e legado marcam `blocked`; duplicação preserva a marcação; IA só cria notas/tarefas validadas |
| `widgetType` com variação (`"aurora.sandbox-html "`) | Widget desconhecido: não renderiza |
| Abrir `/sandbox.html` direto (top-level) ou num iframe sem sandbox | Recusa-se a executar (`self.origin !== 'null'`); só aceita mensagens de `window.parent` (E2E) |
| Navegar o frame do sandbox (location, meta refresh) para outra origem/`data:` | Bloqueado por `frame-src 'self'` (3 motores); mesma origem: detectado e desmontado |
| Enviar `setState` a partir de um documento navegado | Ignorado após o 2º `load`; com bloqueio, o documento nunca existe |
| HTML/SVG como "PDF", "PNG", texto; MIME divergente entre metadado, data URL e bytes | A decisão vem só dos bytes; nenhum caminho cria documento ativo (unitário + E2E 3 motores) |
| Link "Baixar" aberto em nova aba | Sempre `application/octet-stream` (baixa, não renderiza) |
| Imagem do quadro que é HTML ou "bomba" | Não vai ao decodificador; aviso no lugar; asset preservado |
| `schemaVersion` extremo, pontos `null`, títulos de 2 M caracteres | Corrigidos (S1-SEC-018); fuzz de 600 casos sem exceção não tratada |
| Cor com aspas/`<`/`url(` → SVG exportado | Recusada na importação e escapada na exportação |
| Vizinho de rede com `vite --host` + `Host: localhost` | Recusado pelo endereço do socket (proxy e servidor) |
| Flag de runtime para ligar `window.__aurora` | Não existe: constante de build; ausente do bundle público |

## Matriz final

Commits: `1e1e23f` documentos · `e917ee0` importação · `79600bc` sandbox · `5aff2ae` mídias · `5b986ca` frontend ·
`15eedac` servidor · `fa96ab7` CSP · `e4ae4c5` CI · `394ffe7` segunda auditoria.

| ID | Gravidade original (L/E/B) | Evidência | Arquivos | Commit | Testes | Resultado | Residual | Status |
|---|---|---|---|---|---|---|---|---|
| S1-SEC-001 | P0/P0/P0 | Reproduzido em Chromium e WebKit (DOM, localStorage, IndexedDB) | `documents.tsx`, `core/media.ts` | `1e1e23f` | `media.test.ts`; E2E S1-SEC-001 | Sem iframe de documento; tipo pelos bytes | — | **Corrigido** |
| S1-SEC-002 | P1 | Reproduzido no Chromium (nova aba) | `documents.tsx`, `core/media.ts` | `1e1e23f` | E2E download octet-stream | Download neutro | — | **Corrigido** |
| S1-SEC-003 | P2/P1/P1 | Execução automática e navegação reproduzidas | `sandbox.tsx`, `public/sandbox.html`, `widgetData.ts`, `exportImport.ts`, `index.html`, `hosting/headers.ts` | `79600bc`, `fa96ab7` | `active-content.test.ts`; E2E S1-SEC-003 | Inativo até consentimento; navegação bloqueada; limites; modo seguro | Phishing visual após o usuário ativar; CPU não reproduzido | **Mitigado** |
| S1-SEC-004 | P2/P1/P1 | Sonda: 1 M elementos aceitos | `importBudget.ts`, `exportImport.ts`, `fileActions.tsx` | `e917ee0` | `import-hardening.test.ts` (volume, limites) | Recusa antes do saneamento | Arquivo de até 200 MB ainda é lido e passa por `JSON.parse` | **Mitigado** |
| S1-SEC-005 | P1 | Sonda: `RangeError` em stringify/clone | `importBudget.ts`, `exportImport.ts` | `e917ee0` | aninhamento 10⁵/10⁶ | Recusado | — | **Corrigido** |
| S1-SEC-006 | P2 | Leitura de código | `adapter.ts`, `indexeddb.ts`, `exportImport.ts` | `e917ee0` | falha simulada + transação abortada | Tudo ou nada (IndexedDB/memória) | Adaptadores futuros sem `commitImport` caem no modo sequencial | **Corrigido** |
| S1-SEC-007 | P2 | Sonda: `<script>` no SVG | `exportImage.ts`, `migrations.ts` | `e917ee0` | cores + SVG | Validação + escape | — | **Corrigido** |
| S1-SEC-008 | P2 | Leitura de código | `migrations.ts` | `e917ee0` | `sanitizeSettings` | Campo a campo | — | **Corrigido** |
| S1-SEC-009 | P3/P2/P2 | `grep` no `dist` | `main.tsx`, `config/runtime.ts` | `5b986ca`, `fa96ab7` | E2E público; CI `grep` | Ausente do bundle | — | **Corrigido** |
| S1-SEC-010 | P2 | Leitura de código | `actions.ts` | `79600bc` | E2E colagem | `normalizeElement` + bloqueio | — | **Corrigido** |
| S1-SEC-011 | P3/P2/P2 | Leitura de código | `notes.tsx`, `link.tsx` | `5b986ca` | E2E público (0 requisições externas) | Clique para carregar | Após o clique, o servidor externo vê o IP | **Mitigado** |
| S1-SEC-012 | —/P2/P2 | Inexistente | `hosting/*`, `vite.config.ts`, `public/_headers`, `vercel.json` | `fa96ab7` | `hosting.test.ts`; E2E público 3 motores × 2 fases | Report-Only limpo → aplicada | Não validado numa hospedagem real | **Mitigado** (pendente homologação) |
| S1-SEC-013 | P1 cond./—/P0 | Leitura de código | `vite.config.ts`, `server/*` | `15eedac` | `server-hardening.test.ts` | Só loopback | Sem autenticação por desenho | **Mitigado** (local); backend público **fora do escopo** |
| S1-SEC-014 | P3/—/P1 | Leitura de código | `server/app.ts` | `15eedac` | limites e concorrência | 429 + Retry-After | Não substitui cotas por usuário | **Mitigado** |
| S1-SEC-016 | —/P2/— | Leitura de código | `config/runtime.ts`, `aiClient.ts`, `link.tsx`, `ai.tsx` | `5b986ca` | E2E público | "Indisponível nesta versão pública" | — | **Corrigido** |
| S1-SEC-017 | P2 | Workflow | `.github/*`, `.gitleaks.toml` | `e4ae4c5` | CI | SHA, gitleaks, CodeQL, Dependabot | Actions v4 rodam em Node 20 forçado a 24 (aviso do GitHub) | **Mitigado** |
| S1-SEC-018 | P1 | Fuzzing | `migrations.ts`, `aiTiles.ts`, `financeCard.ts` | `e917ee0` | `S1-SEC-018` + fuzz 600 | Laços limitados | — | **Corrigido** |
| S1-SEC-019 | P1 (dev) / P2 (público, CSP herdada) | Revisão | `documents.tsx` | `394ffe7` | E2E SVG | `data:` | — | **Corrigido** |
| S1-SEC-020 | P2 | Revisão | `exportImport.ts` | `394ffe7` | unitário | Tetos no legado | — | **Corrigido** |
| S1-SEC-021 | P2 | Revisão | `actions.ts` | `394ffe7` | E2E | Orçamento na colagem | — | **Corrigido** |
| S1-SEC-022 | P2 | Revisão | `ElementView.tsx`, `actions.ts` | `394ffe7` | unitário de dimensões | Leitura estendida | JPEG cujas dimensões nem em 4 MB aparecem é exibido | **Mitigado** |
| CPU no sandbox | P1 hipotético | Não reproduzido (gap 19/33 ms) | — | — | sonda | — | Firefox não medido | **Não reproduzido** |
| SSRF (Raven #5) | — | Proteções revalidadas | `server/netSafety.ts` | — | testes existentes | — | — | **Refutado** (como vulnerabilidade atual) |

"Não reproduzido" não é "corrigido": o laço de CPU continua mitigado apenas por ativação consciente + modo seguro.
