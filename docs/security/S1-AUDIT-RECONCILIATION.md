# S1 — Confronto com a auditoria da Raven (Etapa 3) e reprodução dinâmica (Etapa 4)

A auditoria própria ([`S1-INDEPENDENT-AUDIT.md`](S1-INDEPENDENT-AUDIT.md), commit `d320489`) foi concluída antes deste
confronto. Reproduções: Playwright 1.65 contra o dev server local (`localhost:5173`), dados fictícios,
nenhuma requisição externa. Spec: `e2e/security.spec.ts` (testes marcados `[reprodução]` falhavam antes das correções).

## Ambiente das reproduções

| Item | Valor |
|---|---|
| Commit | `709f0dc` + arquivos de teste (nenhuma correção) |
| Node / npm | 24.15.0 / 11.12.1 |
| Navegadores | Chromium 1255, WebKit 2388 (Playwright). **Firefox 1572 não executa nesta máquina** (o Windows bloqueia o binário não assinado: `spawn UNKNOWN` / "Permission denied", mesmo após `playwright install --force firefox`); Firefox é coberto pela matriz da CI |

## Matriz

Legenda — **Ambas**: identificado pelas duas auditorias · **Só Claude** · **Só Raven** ·
**Dinâmico**: confirmado em navegador/sonda · **Refutado** · **Condicional** · **Investigar**.

| Raven # | Achado | ID Claude | Classificação | Resultado |
|---|---|---|---|---|
| 1 | DoS por importação de quadros grandes | S1-SEC-004 | Ambas · Dinâmico (sonda Node) | 1 000 000 elementos (500 × 2 000, 73 MB) e 2 000 000 pontos de desenho aceitos; `File.text()` antes de checar tamanho. **P1 público** |
| 2 | Phishing por widgets HTML | S1-SEC-003 | Ambas · Dinâmico | HTML importado executa ao abrir o quadro, sem consentimento. Além do phishing, **só Claude**: navegação do próprio frame escapa da CSP do `srcdoc` e o documento navegado continua aceito como emissor de `setState` (Chromium e WebKit) |
| 3 | Expor o servidor sem autenticação é crítico | S1-SEC-013 | Ambas · Condicional | Correto como risco do modelo C. **Só Claude**: com `vite --host`, um vizinho de rede alcança `/api` pelo proxy enviando `Host: localhost` |
| 4 | Ausência de rate limiting | S1-SEC-014 | Ambas | Confirmado por leitura; impacto local baixo (só clientes locais passam), relevante no modelo C |
| 5 | Revisar SSRF | — | Ambas · Refutado (como vulnerabilidade) | Proteções revalidadas: `lookup` na conexão, redirects revalidados, BlockList, portas; testes existentes cobrem rebinding/redirect para metadados. Mantido como controle a preservar |
| 6 | Preservar proteções de Markdown e links | F10/F11 | Ambas · Proteção verificada | `DOMPurify` + `noopener`; falso positivo para "XSS por `dangerouslySetInnerHTML`". Fuzz adicional na Etapa 9 |
| 7 | Riscos de supply chain | S1-SEC-017 | Ambas | `npm audit` 0; actions por tag e sem SAST/segredos/Dependabot — P2 |
| 8 | Limitações do diário de recuperação | — | Ambas | `localStorage` ~5 MB e texto puro; já documentado. P3 |
| 9 | CSP para hospedagem | S1-SEC-012 | Ambas | Não existe CSP nem configuração de hospedagem. P2 (P1 para a mitigação de navegação do sandbox) |
| 10 | Avisos e restrições para HTML importado | S1-SEC-003 | Ambas | Ver #2 — exige ativação consciente, não só aviso |
| 11 | Limites de complexidade | S1-SEC-004/005 | Ambas · Dinâmico | **Só Claude**: profundidade de `widget.data` sem limite → `RangeError` em `JSON.stringify`/`structuredClone` → autosave e **exportação de backup do workspace falham** (S1-SEC-005) |
| 12 | Falta de auditoria dinâmica | — | Ambas | Endereçado neste ciclo (`e2e/security.spec.ts`, sondas) |
| extra | PDF + data URL HTML + Blob em iframe sem sandbox | **S1-SEC-001** | Ambas · **Dinâmico (P0)** | Ver abaixo |
| — | Link "Baixar" serve blob ativo na origem | S1-SEC-002 | Só Claude · Dinâmico (Chromium) | Abrir o link em nova aba executou o HTML na origem `http://localhost:5173` e gravou no `localStorage`. WebKit recusou navegar para o blob (não reproduzido) |
| — | Injeção no SVG exportado | S1-SEC-007 | Só Claude · Dinâmico (sonda) | Cor manipulada vira `<script>`/`onload` no SVG exportado |
| — | `board.settings` não validado | S1-SEC-008 | Só Claude · Investigar→corrigir | `gridSize` livre → `snap(x, 0) = NaN` |
| — | `window.__aurora` em produção | S1-SEC-009 | Só Claude | Presente no bundle de produção (`grep` no `dist`) |
| — | Colar JSON do Aurora sem validação | S1-SEC-010 | Só Claude · Investigar→corrigir | Leitura de código; corrigido por validação |
| — | Recursos externos de quadros importados (rastreamento) | S1-SEC-011 | Só Claude | `preview.image` e `<img>` em Markdown disparam requisições ao abrir o quadro |
| — | Build público chama `/api` com mensagens de dev | S1-SEC-016 | Só Claude | Mensagens mandam "rodar `npm run dev`" |
| — | Importação não atômica | S1-SEC-006 | Só Claude | Assets → quadros → workspace em operações separadas |
| — | Laço de CPU no sandbox trava a aba | S1-SEC-003(3) | Só Claude · **Não reproduzido** | Laço de 3 s no iframe: maior intervalo da thread principal 19 ms (Chromium) / 33 ms (WebKit) — frames isolados em outro processo nesses motores. Firefox não medido localmente |

## S1-SEC-001 — resultado da investigação do iframe de documentos

| Pergunta | Resposta (evidência) |
|---|---|
| MIME efetivo do Blob | O do **cabeçalho do data URL** (`dataURLToBlob`), não o `doc.mimeType` nem o `asset.mimeType` |
| MIME declarado | `application/pdf` decide **que** é renderizado em `<iframe>` |
| Origem da URL `blob:` | A do app (`blob:http://localhost:5173/...`) |
| Acesso ao documento pai | **Sim** — `parent/top.document.documentElement` recebeu `data-pwned="top-dom"` (Chromium e WebKit) |
| Acesso ao IndexedDB | **Sim** — `indexedDB.open('aurora-board')` abriu e listou 5 object stores |
| Acesso ao localStorage | **Sim** — `aurora-s1-pwned=storage` gravado |
| Gatilho | Nenhuma interação: o primeiro documento é selecionado e pré-visualizado ao abrir o quadro importado |
| Variante `data:application/pdf` com HTML | Não executa (visualizador de PDF), mas o iframe continua sem `sandbox` |
| SVG com script (`<img>`/documento `image/svg+xml`) | Não executa em `<img>` (Chromium/WebKit) |
| Efeito de uma CSP do app | Uma CSP com `script-src 'self'` **herdada** pelo blob bloquearia o script inline, mas não é defesa suficiente (sem CSP no dev; `blob:` em `frame-src` reabriria) — a correção precisa ser estrutural |
| Abrir fora do sandbox | Sim, pelo link "Baixar" em nova aba (S1-SEC-002) |

**Conclusão:** P0 confirmado nos modelos A e B. Cadeia completa: arquivo de backup → import → abrir quadro →
script com acesso total aos quadros da vítima (leitura, alteração, exfiltração quando houver rede).

## Divergências

- Não rebaixamos o #3 (servidor exposto) por existirem Host/Origin checks: com Host forjado a API fica aberta.
- Não elevamos o "travamento por CPU no sandbox" a P1: não reproduzido nos motores testados; fica como risco
  residual com mitigação (HTML importado inativo por padrão + modo seguro).
- SSRF (#5) não é uma vulnerabilidade atual; é um controle a preservar com testes de regressão.
