# S1 — Auditoria independente (Etapa 2)

> Auditoria feita **antes** de qualquer correção do ciclo S1, sobre `main@709f0dce473cca` (merge do ciclo 5),
> na branch `security/public-beta-hardening-s1`. A auditoria externa (Raven) só foi consultada depois deste
> documento estar escrito — o confronto está em [`S1-AUDIT-RECONCILIATION.md`](S1-AUDIT-RECONCILIATION.md).
>
> "Estática" = leitura de código. "Sonda" = experimento local com dados fictícios (Vitest/Playwright).
> Nada aqui foi testado contra servidores de terceiros.

## 1. Escopo real analisado

| Área | Arquivos lidos integralmente |
|---|---|
| Servidor local | `server/app.ts`, `server/index.ts`, `server/netSafety.ts`, `server/providers.ts` |
| Entrada do app | `src/main.tsx`, `src/App.tsx`, `index.html`, `vite.config.ts` |
| Widgets com conteúdo ativo ou externo | `documents.tsx`, `sandbox.tsx`, `thirdParty.tsx`, `notes.tsx`, `ai.tsx`, `code.tsx`, `link.tsx`, `registry.ts`, `WidgetFrame.tsx` |
| Modelo e saneamento | `core/schema.ts`, `core/widgetData.ts`, `core/elements.ts` (clonagem), `core/checkpoints.ts` |
| Persistência | `persistence/exportImport.ts`, `migrations.ts`, `legacy.ts`, `autosave.ts`, `indexeddb.ts`, `store/init.ts` |
| Arquivos/assets | `store/actions.ts` (colar, assets, imagens, links), `canvas/Canvas.tsx` (arrastar-e-soltar), `canvas/ElementView.tsx`, `ui/fileActions.tsx`, `render/exportImage.ts`, `render/shapes.ts` |
| IA | `integrations/aiClient.ts`, `integrations/aiContext.ts` |
| Supply chain / CI | `package.json`, `package-lock.json` (via `npm audit`), `.github/workflows/ci.yml`, `.gitignore`, `.env.example`, histórico git (busca por chaves) |
| Documentação | `docs/SECURITY.md`, `docs/KNOWN_ISSUES.md` |

Busca por sinks em todo `src/`: `dangerouslySetInnerHTML`, `innerHTML`, `srcDoc`, `window.open`, `postMessage`,
`createObjectURL`, `eval`, `new Function`, `document.write`, `insertAdjacentHTML`, `__aurora`, `console.*`.

## 2. Modelo de ameaça (resumo — detalhado em [`S1-THREAT-MODEL.md`](S1-THREAT-MODEL.md))

- **A — uso local:** o atacante não controla a máquina; controla **arquivos** que o usuário importa/anexa/cola
  e **sites** que o usuário visita enquanto o servidor local está no ar.
- **B — frontend público estático:** igual ao A, sem servidor de IA; o atacante pode distribuir backups,
  imagens e documentos manipulados e explorar a configuração da hospedagem. Cada usuário só tem os próprios dados
  (IndexedDB do navegador), então o valor do ataque é **o conteúdo do quadro da vítima** e a **integridade/disponibilidade**
  do armazenamento local.
- **C — backend exposto (cenário de risco, fora do escopo de implantação):** quem alcança a API gasta créditos de IA.

Ativo mais sensível no frontend: a **origem do app** (`https://<host>`), porque quem executa script nela lê e altera
todos os quadros do IndexedDB, o diário do `localStorage` e pode exfiltrar tudo.

## 3. Superfícies de ataque (fonte → validação → transformação → destino → impacto)

| # | Fonte não confiável | Validação atual | Transformação | Destino sensível | Impacto possível |
|---|---|---|---|---|---|
| F1 | Backup JSON → asset `dataURL` + `docs[].mimeType` | `AssetSchema`: só `z.string()`; `sanitizeDocuments`: só tipos | `dataURLToBlob` usa o MIME **do cabeçalho do data URL**; o iframe é escolhido pelo `doc.mimeType` | `<iframe src=blob:>` **sem `sandbox`** | Script na origem do app (S1-SEC-001) |
| F2 | Backup/arquivo anexado → link "Baixar" | nenhuma | blob com o MIME original | `<a href=blob: download>` (abrir em nova aba renderiza) | Script na origem do app com interação (S1-SEC-002) |
| F3 | Backup → widget `aurora.sandbox-html` (`data.html`) | `str()` | `srcdoc` com meta CSP | `<iframe sandbox="allow-scripts">` executa **ao abrir o quadro** | Phishing visual, CPU, navegação do frame para fora da CSP (S1-SEC-003) |
| F4 | Backup JSON inteiro | 200 MB (em caracteres, **após** `File.text()`), 500 quadros, 100 000 elementos/quadro (**após** migrar) | `JSON.parse` → zod → `migrateBoard` por quadro | IndexedDB, renderização | Travamento/memória (S1-SEC-004) |
| F5 | `widget.data` (z.unknown) e outros campos livres | nenhuma profundidade/tamanho | `structuredClone`/`JSON.stringify` em autosave, exportação, resumo | IndexedDB, exportação de backup | Exceção de pilha → falha de salvamento/exportação (S1-SEC-005) |
| F6 | Backup → cores (`style.*Color`) | `z.string()` | concatenação **sem escape** em atributos SVG (`partsSVG`) | arquivo SVG exportado | Script no SVG exportado (S1-SEC-007) |
| F7 | Backup → `board.settings` | **não validado** (spread) | — | grade/encaixe | NaN em coordenadas, grade degenerada (S1-SEC-008) |
| F8 | Área de transferência (JSON do Aurora) | só `type` e `Array.isArray` | `cloneElements` sem `ElementSchema` | quadro e autosave | Elementos malformados persistidos (S1-SEC-010) |
| F9 | Backup → `preview.image` de links; `<img>` em Markdown | só `http(s)` | — | requisição do navegador ao abrir o quadro | Rastreamento/IP da vítima (S1-SEC-011) |
| F10 | Markdown (notas, respostas da IA) | `marked` + `DOMPurify` | `<a ` → `target=_blank rel=noopener` | `dangerouslySetInnerHTML` | Protegido (ver §4) |
| F11 | Código (widget Código) | `highlight.js` (escapa) | — | `dangerouslySetInnerHTML` | Protegido |
| F12 | Imagens (upload, colar, soltar, backup, legado) | `image/*` pelo `File.type`; backup sem checagem | data URL | `<img src>` e `<image href>` (SVG export, escapado) | `<img>` não executa scripts — protegido; SVG com script só seria perigoso se aberto como documento (F2) |
| F13 | Sites visitados → `127.0.0.1:8787` | Host local, Origin local, `Content-Type: application/json`, 2 MB | — | provedores de IA pagos | Protegido no modelo A; sem rate limit (S1-SEC-014) |
| F14 | Rede local quando o dev server é exposto (`vite --host`) | Host do proxy = do cliente (rejeitado), mas Host forjado `localhost` passa | proxy do Vite → API | provedores de IA pagos | Gasto de créditos por vizinho de rede (S1-SEC-013, condicional) |
| F15 | Build público | — | `window.__aurora` exposto | API interna completa no `window` | Superfície desnecessária (S1-SEC-009) |

## 4. Proteções verificadas (preservar)

- **Sandbox de widgets HTML:** `sandbox="allow-scripts"` sem `allow-same-origin` (origem opaca), CSP no `srcdoc`
  (`default-src 'none'`), mensagens aceitas só da janela do próprio iframe, ≤ 100 KB, campos extras recusados,
  throttle 10/s. Código revisado; comportamento dinâmico verificado na Etapa 4.
- **Plugins de terceiros (`registerSandboxedPlugin`)**: HTML vem do manifesto, nunca do quadro; prefixo `aurora.` reservado.
  Não há caminho na UI que registre manifestos hoje.
- **Markdown:** `DOMPurify` com perfil HTML, sem `style`/`iframe`/`form`/atributo `style`; `javascript:` bloqueado pelo
  `ALLOWED_URI_REGEXP` padrão; links com `noopener noreferrer`.
- **Links externos:** `safeHttpUrl`/`safeExternalUrl`; `window.open(..., 'noopener,noreferrer')`.
- **Servidor:** bind `127.0.0.1`; anti DNS-rebinding por `Host`; anti-CSRF por `Origin` + JSON obrigatório; SSRF com
  `lookup` validado na conexão, redirects revalidados, portas 80/443, BlockList ampla; corpo 2 MB; `redactSecrets`;
  cancelamento propaga ao provedor; timeout de 90 s.
- **Chaves:** só em `.env` (ignorado pelo git); nenhuma chave encontrada no histórico (busca por `sk-`, `sk-ant-`,
  `sk-proj-`, `AIza`); `.env.example` sem valores.
- **Importação nunca sobrescreve** quadros (ids colidentes recebem id novo) nem assets existentes.
- **Fórmulas:** parser próprio, sem `eval`/`new Function`.

## 5. Vulnerabilidades confirmadas (nesta etapa, por sonda)

### S1-SEC-007 — Injeção de marcação no SVG exportado
- **Gravidade:** P2 (local e público). **Confiança:** alta. **Status:** reproduzido (sonda Vitest).
- **Pré-condição:** quadro importado com cor manipulada; usuário exporta SVG e abre o arquivo no navegador.
- **Evidência:** `backgroundColor = 'red"/><script>alert(1)</script><path d="'` e `strokeColor = 'blue" onload="alert(2)'`
  passam por `migrateBoard` e aparecem literais no SVG (`render/exportImage.ts` › `partsSVG`, sem `esc()`).
- **Impacto:** script no SVG aberto como arquivo (`file://`) ou servido de outra origem; **não** atinge a origem do app
  (a rasterização PNG usa `<img>`). Vira grave se o SVG for reaberto como documento ativo (ver S1-SEC-002).
- **Mitigação proposta:** escapar todos os atributos; validar cores no import (formato CSS restrito, tamanho).

### S1-SEC-005 — Dados profundamente aninhados quebram salvamento e exportação
- **Gravidade:** P1 (disponibilidade/integridade dos backups). **Confiança:** alta. **Status:** reproduzido (sonda).
- **Evidência:** `state` de widget com 100 000 níveis é aceito por `parseImport` em 23 ms; em seguida
  `JSON.stringify(board)` e `structuredClone(board)` lançam `RangeError: Maximum call stack size exceeded`.
- **Impacto:** o quadro importado não salva (IndexedDB usa clone estruturado), a importação pode ficar **parcial**
  (assets gravados antes), e **"Exportar backup do workspace" passa a falhar para todos os quadros** — o mecanismo de
  backup do usuário é anulado por um único arquivo importado.
- **Mitigação proposta:** orçamento de profundidade/nós iterativo antes da validação; gravação transacional.

### S1-SEC-004 — Importação sem orçamento de recursos agregado
- **Gravidade:** P1 (público), P2 (local). **Confiança:** alta. **Status:** reproduzido parcialmente (sonda; custo no navegador será maior).
- **Evidência (Node 24, máquina de desenvolvimento):** 100 000 elementos/7,8 MB → 459 ms; **500 quadros × 2 000 elementos
  (1 000 000 elementos, 73 MB) aceitos** em 3,3 s só de parse/validação; 1 desenho livre com 2 000 000 pontos (42 MB)
  aceito. `File.text()` é chamado antes de qualquer checagem de tamanho; o limite de 200 MB compara **caracteres**.
  Assets do backup não têm limite de tamanho/quantidade (o limite de 25 MB vale só para anexos locais).
- **Impacto:** travamento/estouro de memória da aba e gravação de centenas de MB no IndexedDB a partir de um arquivo.
- **Mitigação proposta:** `File.size` antes da leitura; orçamento de complexidade (quadros, elementos totais, pontos,
  texto, HTML, assets, bytes de data URL); mensagens claras.

## 6. Vulnerabilidades suspeitas (reprodução dinâmica na Etapa 4)

### S1-SEC-001 — Documento "PDF" com conteúdo HTML executa na origem do app (hipótese P0)
- **Fluxo:** `documents.tsx` › `Preview`: `dataURLToBlob` cria o Blob com o MIME do **cabeçalho do data URL**
  (`data:text/html;...`), enquanto a decisão de usar `<iframe>` usa `doc.mimeType === 'application/pdf'`
  (metadado do backup). O iframe **não tem `sandbox`** e a URL `blob:` herda a origem do app.
- **Hipótese:** um backup com `mimeType: application/pdf` e `dataURL: data:text/html;base64,...` executa script com acesso
  a `parent.document`, `localStorage` e `IndexedDB` assim que o documento é selecionado (o primeiro é selecionado
  automaticamente ao abrir o quadro importado).
- **Gravidade se confirmada:** P0 em todos os modelos. **Confiança estática:** alta.

### S1-SEC-002 — Link "Baixar" serve conteúdo ativo como blob da origem do app
- `<a href=blob: download>` com o MIME original (`text/html`, `image/svg+xml`, `application/xhtml+xml`...). Clique simples
  baixa; "abrir em nova aba"/clique do meio pode renderizar o documento na origem do app.
- **Gravidade se confirmada:** P1 (exige interação). **Confiança:** média (depende do navegador).

### S1-SEC-003 — HTML personalizado importado executa automaticamente
- Ao abrir um quadro importado, todo `aurora.sandbox-html` roda sem consentimento. Isolado (origem opaca), mas:
  1. **phishing visual** dentro do quadro (formulários falsos não enviam, mas texto/links induzem o usuário);
  2. **navegação do próprio frame** (`location = ...`, `<meta refresh>`) não é bloqueada por `sandbox` nem pela CSP do
     `srcdoc` — o novo documento **não tem a CSP** e ganha rede; o host ainda reenvia `aurora:init` com o estado para ele
     (`postMessage(..., '*')` no `onLoad`);
  3. **CPU:** laço infinito pode travar a aba se o navegador não isolar o frame em outro processo — e como o último quadro
     aberto é reaberto ao iniciar, o travamento seria persistente.
- **Gravidade:** P1 (público), P2 (local). **Confiança:** alta para (1)/(2), a medir para (3).

### S1-SEC-010 — Colar JSON do Aurora não valida elementos
- `pasteContent` aceita `{type: CLIPBOARD_TYPE, elements: [...]}` de qualquer texto colado e clona sem `ElementSchema`.
  Um site pode preparar esse texto na área de transferência. Elementos malformados entram no quadro e no autosave.
- **Gravidade:** P2. **Confiança:** média (impacto exato depende da renderização).

### S1-SEC-008 — `board.settings` não validado na importação
- `{ ...DEFAULT_BOARD_SETTINGS, ...obj(b.settings) }` aceita `gridSize: 0`/texto → `snap(x, 0)` = `NaN`.
- **Gravidade:** P2 (integridade). **Confiança:** média.

## 7. Falsos positivos (APIs presentes, sem cadeia de exploração)

| Item | Por que não é vulnerabilidade |
|---|---|
| `dangerouslySetInnerHTML` em notas e IA | Saída do `DOMPurify`; o pós-processamento só acrescenta atributos a tags já saneadas |
| `dangerouslySetInnerHTML` no widget Código | `highlight.js` escapa o texto; linguagem restrita a uma lista |
| `postMessage(..., '*')` para o sandbox | O destino é uma origem opaca, não há alvo nomeável; o problema real é o reenvio após navegação (S1-SEC-003) |
| Imagens com data URL arbitrário | Renderizadas só em `<img>`/`<image>`: scripts e HTML não executam |
| `window.open` | Só URLs `https` validadas, com `noopener,noreferrer` |
| Asset importado com id já existente | Mantém o existente; ids são aleatórios (`uid`) — atacante não conhece ids da vítima |
| `console.error/warn` | Só ids de quadro e erros de gravação; nenhum conteúdo de mensagem de IA ou chave |

## 8. Riscos condicionais

- **S1-SEC-013 — API exposta:** sem autenticação; protegida só por loopback + Host/Origin. Se alguém expuser o
  dev server (`vite --host`), um vizinho de rede consegue chamar `/api/ai/chat` com `Host: localhost` (Origin ausente é
  aceito) e **gastar créditos**. Proxy reverso que reescreva `Host` para `localhost` tem o mesmo efeito. P0 no modelo C,
  P1 condicional no modelo A.
- **Cabeçalhos de hospedagem:** não existe CSP nem configuração de hospedagem (S1-SEC-012). Sem CSP, a mitigação
  de navegação do sandbox (frame-src) e de injeções futuras não existe.
- **Build público chamando `/api`:** a hospedagem estática responderia 404/HTML; mensagens atuais mandam "rodar `npm run dev`"
  (S1-SEC-016).

## 9. Riscos de disponibilidade

- S1-SEC-004 (cargas enormes), S1-SEC-005 (aninhamento), S1-SEC-003(3) (CPU no sandbox).
- Diário em `localStorage` (~5 MB): quadros grandes não cabem — limitação já documentada em `KNOWN_ISSUES.md`.
- `applyImport` grava assets, depois quadros, depois o workspace, em operações independentes (S1-SEC-006):
  falha no meio deixa estado parcial sem aviso.

## 10. Dependências e supply chain

- `npm audit --omit=dev` e `npm audit` completos: **0 vulnerabilidades** (19/11/2026).
- 15 dependências de produção, todas de uso direto; `dompurify` e `marked` são as críticas para segurança.
- CI: `permissions: contents: read` (bom); actions por **tag** (`@v4`), não por SHA (S1-SEC-017); `npm audit || true`
  informativo; sem análise estática de segurança (CodeQL), sem varredura de segredos, sem Dependabot.
- Nenhuma publicação/deploy automático no workflow; artefato `dist` com retenção de 7 dias (sem segredos: build não lê `.env`).
- Build: sem source maps no `dist`; `window.__aurora` presente no bundle de produção (S1-SEC-009).

## 11. Lacunas de testes

- Nenhum teste de documentos com MIME inconsistente, de SVG ativo, de link de download.
- Nenhum teste de importação com orçamento (só limites de quadros/elementos), profundidade, assets enormes.
- Sandbox: há testes unitários de protocolo, mas **nenhum teste em navegador** de isolamento (DOM/storage pai, popups,
  navegação, CPU) nos três motores.
- Nenhum teste de CSP/headers nem de ausência de `__aurora` em produção.

## 12. Priorização (antes da reprodução)

1. **S1-SEC-001** (P0 hipotético) — reproduzir primeiro; corrigir imediatamente se confirmado.
2. **S1-SEC-002, S1-SEC-003** (isolamento de conteúdo ativo).
3. **S1-SEC-005, S1-SEC-004, S1-SEC-006** (importação: integridade e disponibilidade).
4. **S1-SEC-007, S1-SEC-008, S1-SEC-010** (validação de campos).
5. **S1-SEC-009, S1-SEC-011, S1-SEC-012, S1-SEC-016** (produção estática).
6. **S1-SEC-013, S1-SEC-014** (servidor local, defesa em profundidade); **S1-SEC-017** (CI).

## 13. Evidências e arquivos afetados

| ID | Arquivos |
|---|---|
| 001/002 | `src/widgets/builtin/documents.tsx` (`dataURLToBlob`, `Preview`) |
| 003 | `src/widgets/builtin/sandbox.tsx`, `src/widgets/WidgetFrame.tsx` |
| 004/005/006 | `src/persistence/exportImport.ts`, `src/ui/fileActions.tsx`, `src/core/schema.ts` |
| 007 | `src/render/exportImage.ts` (`partsSVG`, `textLines`) |
| 008 | `src/persistence/migrations.ts` |
| 009 | `src/main.tsx` |
| 010 | `src/store/actions.ts` (`pasteContent`) |
| 011 | `src/widgets/builtin/link.tsx`, `src/widgets/builtin/notes.tsx` |
| 012/016 | `vite.config.ts`, `index.html`, `src/integrations/aiClient.ts`, `link.tsx` |
| 013/014 | `server/app.ts`, `server/index.ts`, `vite.config.ts` |
| 017 | `.github/workflows/ci.yml` |

Sondas: `tests/unit/_probe_import.test.ts` e `_probe_svg.test.ts` (temporárias; convertidas em testes de regressão
permanentes nas etapas de correção). Specs E2E de reprodução: `e2e/security.spec.ts`.

## 14. Limitações desta auditoria

- Um único auditor (Claude), sem ferramenta de DAST/SAST dedicada; a varredura de sinks é por busca textual + leitura.
- Medidas de desempenho em Node, não no navegador — o custo real (renderização, IndexedDB) é maior.
- O comportamento de visualizadores de PDF e de isolamento de processo dos iframes depende da versão do navegador;
  só os motores instalados pelo Playwright 1.65 foram usados.
- Não houve teste de hospedagem real (não existe ambiente de homologação configurado).
