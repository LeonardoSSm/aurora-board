# Aurora Board — Ciclo S1: relatório final de segurança

Branch `security/public-beta-hardening-s1` a partir de `main@709f0dc` (merge do ciclo 5). Autoria: Helena (Claude Code).
Documentos de apoio: [auditoria independente](S1-INDEPENDENT-AUDIT.md) · [modelo de ameaça](S1-THREAT-MODEL.md) ·
[confronto com a Raven](S1-AUDIT-RECONCILIATION.md) · [achados e baseline](S1-FINDINGS.md) ·
[segunda auditoria e matriz final](S1-REVALIDATION.md) · [hospedagem](S1-HOSTING.md) · [checklist](S1-RELEASE-CHECKLIST.md).

## A. Resumo executivo

Encontrei e reproduzi um **P0 real**: um backup com um documento declarado como PDF mas com conteúdo HTML executava
script **com a origem do app** assim que o quadro era aberto — lendo e alterando IndexedDB, localStorage e DOM
(Chromium e WebKit). Está corrigido estruturalmente: nenhum documento vira conteúdo ativo; o tipo é decidido pelos
bytes. Além dele, 21 outros achados (P1–P3), incluindo um congelamento da aba por um campo numérico de 4 bytes
(achado por fuzzing) e uma falha que anulava a exportação de backups. O build público agora é estático, sem
depuração, sem `/api`, com CSP sem `unsafe-inline`/`unsafe-eval` validada em duas fases nos três motores.

Estado: **HOMOLOGAÇÃO** (ver P). Nada foi publicado.

## B. Auditoria independente (antes de qualquer correção)

Feita e commitada antes de ler a auditoria externa (`d320489`). Principais achados próprios: o iframe de
documentos sem sandbox (S1-SEC-001), o link "Baixar" servindo HTML/SVG como `blob:` da origem (002), HTML importado
executando sem consentimento e escapando da CSP do `srcdoc` ao navegar (003), ausência de orçamento agregado na
importação (004), aninhamento que quebrava salvamento e exportação (005), gravação não atômica (006), injeção no SVG
exportado (007), `settings` sem validação (008), `window.__aurora` em produção (009), colagem sem validação (010),
rastreamento por imagens remotas (011), ausência de CSP/headers (012), API acessível via `vite --host` (013).

## C. Confronto com a Raven

Os 12 pontos da Raven foram confirmados ou refinados ([matriz](S1-AUDIT-RECONCILIATION.md)). Concordâncias:
DoS de importação, phishing por HTML, risco do servidor exposto, rate limiting, CSP, supply chain, diário.
**Diferenças:** SSRF não é vulnerabilidade atual (controles revalidados — falso positivo como achado, correto como
item a preservar); "travamento por CPU no sandbox" **não foi reproduzido** (frames isolados em processo próprio).
**Só a Claude:** 002, 005, 007, 008, 009, 010, 011, 016, 018–022 e o vetor `vite --host` + `Host` forjado.
A hipótese extra (PDF/HTML/Blob) foi **confirmada dinamicamente como P0**.

## D. Vulnerabilidades confirmadas

| ID | Gravidade | Evidência | Impacto |
|---|---|---|---|
| S1-SEC-001 | **P0** | E2E: DOM marcado, IndexedDB aberto (5 stores), localStorage gravado — Chromium e WebKit | Leitura/alteração/exfiltração de todos os quadros a partir de um arquivo |
| S1-SEC-002 | P1 | E2E Chromium: HTML do "Baixar" aberto em nova aba gravou no storage | Mesmo impacto, exige clique |
| S1-SEC-003 | P1 (público) | Execução automática; documento navegado aceito como emissor | Phishing visual; saída da CSP do srcdoc |
| S1-SEC-004 | P1 (público) | 1 M elementos / 73 MB aceitos | Travamento e consumo de armazenamento |
| S1-SEC-005 | P1 | `RangeError` em stringify/clone | Backup do workspace inutilizado por 1 quadro |
| S1-SEC-007 | P2 | `<script>` no SVG exportado | Script ao abrir o arquivo exportado |
| S1-SEC-018 | P1 | Fuzz: `schemaVersion: -1e15` → 10¹⁵ iterações | Aba congelada ao importar |
| S1-SEC-019 | P1 (local) | Revisão do próprio ciclo | SVG via blob em nova aba |

Demais (006, 008–017, 020–022): confirmados por leitura de código ou sonda; ver matriz final.

## E. Correções (arquivos e decisões)

- **Documentos/mídias** — `src/core/media.ts` (assinaturas, dimensões, `classifyDocument`, download neutro),
  `documents.tsx` (sem iframe; prévia de PDF desativada), `ElementView.tsx` (imagens validadas antes de decodificar).
- **Importação** — `persistence/importBudget.ts` (orçamento iterativo), `exportImport.ts` (tamanho antes de ler,
  assets, legado, atômico), `adapter.ts`/`indexeddb.ts` (`commitImport` transacional), `migrations.ts`
  (settings, cores, versão, pontos inválidos).
- **Conteúdo ativo** — `public/sandbox.html` (documento hospedeiro com CSP própria; recusa rodar fora de sandbox),
  `sandbox.tsx` (ativação consciente, detecção de navegação, limites, `?safe`), `widgetData.ts` (marcação pelo
  importador), `actions.ts` (colagem validada).
- **Frontend público** — `config/runtime.ts` (constantes de build), `main.tsx`, `aiClient.ts`, `link.tsx`, `notes.tsx`
  (imagens remotas por clique), `BetaNotice.tsx`.
- **Servidor local** — `server/app.ts` (par loopback, limites), `server/index.ts` (timeouts, aviso), `vite.config.ts`
  (proxy só loopback).
- **Hospedagem** — `hosting/headers.ts` (fonte única), `public/_headers`, `vercel.json`, CSP em `<meta>`.
- **CI** — actions por SHA, gitleaks, CodeQL, Dependabot, job do build público, auditoria bloqueante.

Decisão arquitetural principal: **o sandbox deixou de ser `srcdoc`**. Um `srcdoc` herda a CSP do app; com a CSP
pública estrita os widgets não rodariam, e a alternativa (afrouxar `script-src` do app) seria inaceitável.

## F. Testes

| Suíte | Antes | Depois |
|---|---|---|
| Unitários (Vitest) | 336 | **466** (+130: mídia, importação/fuzz, conteúdo ativo, servidor, hospedagem) |
| E2E principal | 106 coletados | + `e2e/security.spec.ts` (24 cenários × Chromium/Firefox/WebKit) |
| E2E do build público | — | `e2e/static` (jornada completa) × 3 motores × 2 fases de CSP |
| Fuzzing | — | 600 variações determinísticas da importação; achou 2 bugs reais (S1-SEC-018) |

Resultados finais: ver seção O (CI) — local: unitários 466/466; E2E de segurança 48/48 (Chromium+WebKit);
jornada pública 2/2 em cada fase. **Limitações:** Firefox não executa nesta máquina (bloqueio do Windows ao binário) —
coberto apenas pela CI; nenhuma execução contra hospedagem real; IA real não testada (sem chaves, por regra).

## G. Segurança dos documentos (iframe e Blob URLs)

O MIME do Blob vinha do cabeçalho do data URL; a escolha do iframe vinha do metadado; o iframe não tinha `sandbox`;
URLs `blob:` herdam a origem do criador. Resultado: HTML executando com acesso total. Hoje: não existe iframe de
documento; o conteúdo é classificado pelos bytes; só imagens (em `<img>`) e texto (em `<pre>`) têm prévia; SVG usa
`data:`; download sempre `octet-stream`. Testado com HTML-como-PDF (data URL `text/html` e `application/pdf`),
SVG com script como imagem e documento, PNG com MIME errado, data URL malformado, asset ausente, PDF válido, abertura
em nova aba — Chromium, WebKit e Firefox (CI).

## H. Importação

Limites e regras em [`docs/SECURITY.md`](../SECURITY.md#importação-de-backups-persistenceimportbudgetts-exportimportts).
Quadros legítimos de 100 000 elementos continuam aceitos (~0,4 s de validação em Node); 1 000 000 de elementos são
recusados na contagem, antes do saneamento. A UI distingue **recusada** (nada alterado), **interrompida** (transação
abortada, nada gravado) e **concluída** (com avisos). Não há "parcialmente recuperada": a gravação é atômica.

## I. Plugins e conteúdo ativo

Isolamento validado em navegador real: sem acesso a DOM/storage do pai, sem popups, sem navegação do topo, sem
formulários, mensagens inválidas/excessivas descartadas, navegação do frame bloqueada (3 motores) ou detectada.
HTML importado/colado desativado até consentimento; decisão persistente; 20 frames simultâneos; `?safe`.

## J. Servidor local

Preservados: bind `127.0.0.1`, Host/Origin, JSON obrigatório, SSRF (lookup na conexão, redirects revalidados),
redação de segredos, cancelamento. Novos: recusa por endereço de socket (também no proxy do Vite), limites por rota
com `429`, timeouts de cabeçalho/requisição, `maxConnections`, aviso de inicialização. **Não** há autenticação e o
servidor **não deve** ser exposto; backend público exige outro ciclo (lista na seção de servidor do SECURITY.md).

## K. Produção estática

CSP (cabeçalho e `<meta>`): `script-src 'self'`, `style-src 'self'`, `connect-src 'self'`, `frame-src 'self'`,
`object-src`/`base-uri`/`form-action` restritos, `frame-ancestors 'none'`; HSTS, `nosniff`, `no-referrer`,
`Permissions-Policy`, COOP/CORP, cache imutável para assets. Exceções justificadas em [S1-HOSTING](S1-HOSTING.md).
Fase Report-Only encontrou 3 causas reais (srcdoc herdando CSP, sonda de eval do Zod, fontes `data:`), corrigidas na
raiz. **Limitação:** validado em `vite preview` e na CI, não numa hospedagem real.

## L. Supply chain

`npm audit` (produção e completo): 0. Nenhum upgrade de dependência foi necessário. Actions fixadas por SHA na
major já usada (v4) — aviso do GitHub sobre Node 20; atualização via Dependabot com revisão. Gitleaks no histórico
completo (sem achados; exceção só para chaves fictícias em testes). CodeQL `security-extended`. Nenhum segredo no
histórico (busca manual por `sk-`, `sk-ant-`, `sk-proj-`, `AIza`).

## M. Desempenho

Mesma máquina, mesma sessão, 5 000 elementos com setas realistas (`perf-results/c5-rep*.json` × `s1-rep*.json`):

| Métrica | Ciclo 5 (`709f0dc`) | S1 |
|---|---|---|
| Abrir quadro | 80,8 / 83,6 ms | 88,6 / 105,4 ms |
| Selecionar (work) | 9,7 / 9,0 ms | 9,4 / 9,5 ms |
| Selecionar (quadro, fit) | 45,0 / 43,2 ms | 43,6 / 46,9 ms |

Interação equivalente; abertura ~+10–25% (validação de imagens e de settings ao abrir), dentro da variação
documentada mas registrada como ponto de atenção. O número antigo do ciclo 5 (52,7 ms) não é comparável: a máquina
estava menos carregada. Importação: 100 000 elementos validados em ~0,4 s (antes 0,46 s); 1 000 000 recusados em
< 1 s (antes processados em 3,3 s).

## N. Riscos residuais

- **P0:** nenhum conhecido.
- **P1:** nenhum aberto relevante ao beta. Condicional: expor o servidor local (modelo C) continua crítico por desenho.
- **P2:** phishing visual por widget HTML **ativado**; CSP não validada em hospedagem real; widgets HTML importados
  antes do S1 tratados como locais; JPEG com dimensões além de 4 MB não checado; arquivos de 200 MB ainda passam por
  `JSON.parse`.
- **P3:** imagem remota revela IP após o clique; diário em `localStorage` em texto puro (~5 MB); laço de CPU no
  sandbox não medido no Firefox; actions em Node 20 forçado.

## O. GitHub

- Branch: `security/public-beta-hardening-s1` — https://github.com/LeonardoSSm/aurora-board/tree/security/public-beta-hardening-s1
- Commits por área: auditoria `d320489`, reprodução `7e24171`, documentos `1e1e23f`, importação `e917ee0`,
  sandbox `79600bc`, mídias `5aff2ae`, frontend `5b986ca`, servidor `15eedac`, CSP `fa96ab7`, CI `e4ae4c5`,
  beta `acc5d49`, segunda auditoria `394ffe7`, ajustes de CI `a672117`/`c9a2519`, documentação (este commit).
- CI: execução `44572154598` (commit `ed90b66`) **verde em todos os 12 jobs** — tipos, unitários, build público
  (conteúdo verificado), auditoria de dependências, gitleaks, E2E Chromium/Firefox/WebKit/mobile e build público + CSP
  (Report-Only e aplicada) em Chromium/Firefox/WebKit — e CodeQL verde. Durante o ciclo a CI revelou 3 problemas de
  teste (coleta de `e2e/static` pela config principal; navegação bloqueada sem 2º `load` no Firefox; colagem
  sintética ignorada pelo Firefox), todos corrigidos sem afrouxar asserções de segurança.
- Local (Windows): 466/466 unitários; E2E 118 aprovados, 1 pulado e 1 falha **preexistente** do WebKit local
  (`editing.spec.ts` › desfazer por quadro; reproduzida também em `709f0dc`, passa na CI).
- Integrações de deploy: nenhuma (0 deployments e 0 environments no GitHub; `vercel.json` com
  `git.deploymentEnabled: false`; nenhum workflow publica). O merge na `main` não publica nada.
- Merge: critérios da Etapa 17 cumpridos; integração na `main` com `--no-ff`, sem force push.
  **Merge na `main` não é autorização de lançamento público.**

## P. Decisão de prontidão

**HOMOLOGAÇÃO** — pronto para testes em ambiente restrito, **não** para público aberto.

Critérios internos de código estão atingidos (nenhum P0/P1 aberto relevante ao beta, testes e CI verdes, build sem
depuração). Faltam itens que só podem ser cumpridos fora deste ambiente: implantação em homologação real com
verificação de cabeçalhos/CSP efetivos e teste em celular real, e a revalidação independente. Concluídos esses
itens do [checklist](S1-RELEASE-CHECKLIST.md), o estado passa a **CANDIDATO A BETA**. A publicação continua sendo
decisão do responsável.
