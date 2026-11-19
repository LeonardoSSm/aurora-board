# S1 — Achados, baseline e plano de correção (Etapa 4)

## Baseline (antes das correções)

| Item | Resultado |
|---|---|
| Commit | `709f0dce473cca6d32801e500e9096d44bf3bd90` |
| Node / npm | v24.15.0 / 11.12.1 (Windows 11) |
| `npm ci` | **Não executável localmente**: um `npm run dev` do usuário estava rodando nesta pasta e trava binários nativos (`lightningcss`, `tailwindcss-oxide`) — `EPERM unlink`. `node_modules` foi reparado com `npm install` (lockfile inalterado). A CI executa `npm ci` limpo |
| `npm run typecheck` | ✅ |
| `npm test` | ✅ 18 arquivos, **336 testes** |
| `npm run build` | ✅ (aviso de chunk > 500 kB, preexistente) |
| `npm run test:e2e:all` | Chromium ✅ 34/34 · WebKit ✅ 34/34 · mobile ✅ 3/3 (+1 skip) · **Firefox 0/34 — falha de launch do navegador nesta máquina** (ambiente, não regressão) |
| `npm run audit:prod` / `npm audit` | 0 vulnerabilidades |
| CI da `main` | Verde no merge do ciclo 5 (`709f0dc`; houve uma reexecução por falha transitória do runner ao instalar navegadores) |

## Matriz de achados

Gravidade por modelo: **L** local · **E** frontend público estático · **B** backend público (hipotético).

| ID | Título | L | E | B | Reprodução |
|---|---|---|---|---|---|
| S1-SEC-001 | Documento "PDF" com HTML executa na origem do app (iframe `blob:` sem sandbox) | P0 | P0 | P0 | ✅ Chromium, WebKit |
| S1-SEC-002 | Link "Baixar" serve HTML/SVG ativo como `blob:` da origem | P1 | P1 | P1 | ✅ Chromium (nova aba); WebKit ✖ |
| S1-SEC-003 | HTML importado executa sem consentimento; navegação do frame escapa da CSP do `srcdoc` | P2 | P1 | P1 | ✅ execução e navegação; CPU ✖ |
| S1-SEC-004 | Importação sem orçamento agregado (tamanho lido antes de checar, 1M elementos, 2M pontos, assets sem limite) | P2 | P1 | P1 | ✅ sonda Node |
| S1-SEC-005 | Profundidade ilimitada em `widget.data` quebra autosave e exportação | P1 | P1 | P1 | ✅ sonda Node |
| S1-SEC-006 | `applyImport` não atômico | P2 | P2 | P2 | leitura de código |
| S1-SEC-007 | Injeção de marcação no SVG exportado | P2 | P2 | P2 | ✅ sonda Vitest |
| S1-SEC-008 | `board.settings` importado sem validação | P2 | P2 | P2 | leitura de código |
| S1-SEC-009 | `window.__aurora` no build de produção | P3 | P2 | P2 | ✅ `grep` no `dist` |
| S1-SEC-010 | Colar JSON do Aurora sem `ElementSchema` | P2 | P2 | P2 | leitura de código |
| S1-SEC-011 | Recursos externos de quadros importados (rastreamento/IP) | P3 | P2 | P2 | leitura de código |
| S1-SEC-012 | Sem CSP/headers/configuração de hospedagem | — | P2 | P2 | ✅ inexistente |
| S1-SEC-013 | API sem autenticação; alcançável via `vite --host` com `Host` forjado | P1 cond. | — | **P0** | leitura de código |
| S1-SEC-014 | Sem rate limit/concorrência no servidor | P3 | — | P1 | leitura de código |
| S1-SEC-016 | Build público chama `/api` e instrui a rodar `npm run dev` | — | P2 | — | leitura de código |
| S1-SEC-017 | Actions por tag, sem SAST/segredos/Dependabot | P2 | P2 | P2 | leitura do workflow |

(S1-SEC-015 foi reservado durante a auditoria para "link preview revela IP ao site-alvo" e descartado: é o
comportamento esperado de uma pré-visualização feita pelo servidor do próprio usuário.)

## Plano de correção (ordem e justificativa)

1. **S1-SEC-001 + 002** — único P0; exploração trivial (um arquivo) e impacto total. Correção estrutural:
   nenhum conteúdo de documento vira documento ativo na origem do app (prévia só para formatos com renderização
   inerte; download sempre `application/octet-stream`).
2. **S1-SEC-003** — conteúdo ativo importado: inativo até consentimento; detecção de navegação do frame;
   CSP do app com `frame-src` restrito no build público.
3. **S1-SEC-005 / 004 / 006** — importação: orçamento iterativo antes da validação completa, `File.size` antes da leitura,
   gravação em transação única. Dependem de um módulo de orçamento comum.
4. **S1-SEC-007 / 008 / 010 / assets** — validação de campos e de mídias (cores, settings, colagem, MIME por assinatura).
5. **S1-SEC-009 / 011 / 016 / 012** — build público: sem `__aurora`, modo estático sem `/api`, política de recursos
   externos, CSP e headers.
6. **S1-SEC-013 / 014** — servidor local: proxy do Vite só aceita loopback, servidor confere o endereço remoto,
   limites de concorrência/taxa, aviso de inicialização.
7. **S1-SEC-017** — CI: actions por SHA, CodeQL, varredura de segredos, Dependabot, auditoria completa bloqueante para altas.

Risco de regressão considerado: (1) e (2) alteram como documentos e widgets HTML aparecem — cobertos por E2E novos
e pelos existentes; (3) mexe na importação — os testes de compatibilidade de backups antigos (fixtures v0.3 e v3)
precisam continuar verdes.
