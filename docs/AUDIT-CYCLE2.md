# Ciclo 2 — Auditoria técnica inicial (Etapa 1)

Data: 2026-11-18 · Branch: `improvement/aurora-board-cycle-2` (a partir de `main` @ `d7eae50`)
Ambiente: Windows 11 Pro, Node 24.15, npm 11.12, Chromium (Playwright 1.65).

## 1. Verificação automatizada (antes de qualquer alteração)

| Comando | Resultado |
|---|---|
| `npm ci` | ok — 110 pacotes, **0 vulnerabilidades** |
| `npm run typecheck` | ok, sem erros |
| `npm test` | **95/95** aprovados (10 arquivos) |
| `npm run build` | ok — aviso: bundle principal ~730 kB (> 500 kB) |
| `npm run test:e2e` | **12/12** aprovados (Chromium) |

Sem dependências com conflito (`npm ls`), nenhuma desatualizada relevante.

## 2. Baseline manual no navegador

Executado no painel do navegador, em um quadro de teste (os quadros do usuário não foram alterados):

| Ação | Resultado |
|---|---|
| Criar elipse, arrastar pela borda | ok |
| Duplo clique na forma e escrever | ok — **porém** a palavra “Baseline” quebrou no meio (“Baselin/e”) numa elipse estreita |
| Seta arrastada entre formas | ok, ancorada nas duas pontas |
| Seleção por área + Ctrl+G, Ctrl+Z, Ctrl+Shift+Z | ok |
| Adicionar widget Notas e digitar | ok |
| **Arrastar para selecionar texto na nota (modo Visualizar)** | **falha: move o bloco inteiro** (x −160 → 18) e não seleciona texto |
| Persistência após reiniciar o servidor | ok (IndexedDB) |
| Trocar de quadro, exportar/importar | cobertos pelos E2E (ok) |

## 3. Mapa de módulos e pontos críticos

```
core/          regras puras (sem React) ── usado por todos
store/         estado + comandos (actions.ts, 924 linhas: elementos, quadros, workspaces, assets, clipboard)
canvas/        controlador de ponteiro (759 linhas, estado de gesto em variáveis de módulo), overlay, editor de texto
persistence/   adaptador, IndexedDB, autosave + diário, migrações, import/export, legado
render/        geração de SVG e exportação
widgets/       contrato, registro, moldura, fluxo de dados, plugins nativos, sandbox
integrations/  cliente de IA e contexto autorizado
ui/            componentes de interface
server/        proxy local (IA + pré-visualização de links)
```

Observações:
- **Inversão de camadas** `store/demo.ts → canvas/controller.ts` (para cores de conexão). Corrigido nesta etapa: estilos de conexão movidos para `core/connectionStyle.ts`.
- `store/actions.ts` concentra muitas responsabilidades. Não será dividido agora (sem ganho funcional imediato); fica registrado.
- O controlador mantém gesto/rascunho em variáveis de módulo: simples e testável, mas só há um editor por página (aceitável).
- Componentes que assinam **todos** os elementos e re-renderizam a cada quadro de arrasto: `Overlay`, `PropertiesPanel`, `ContextMenu`, bloco de IA, `Canvas` (lista visível). A investigar na Etapa 6 com medições.

## 4. Riscos identificados para as próximas etapas (a confirmar com testes)

| # | Área | Suspeita | Etapa |
|---|---|---|---|
| R1 | autosave | gravação antiga limpa o diário de alteração mais nova | 2 |
| R2 | autosave | `saveState = 'saved'` enquanto uma gravação mais nova ainda está na fila | 2 |
| R3 | autosave | diário único (`aurora-board-journal`): alterações não salvas de um quadro são sobrescritas pelas de outro | 2 |
| R4 | carga | quadros lidos do IndexedDB não passam por validação/migração | 2 |
| R5 | servidor | pré-visualização segue redirecionamentos automaticamente (SSRF) e resolve DNS duas vezes (rebinding) | 3 |
| R6 | servidor | sem verificação de `Origin`/`Host`/`Content-Type`: um site qualquer pode fazer POST “simples” para `127.0.0.1:8787` (consumo de créditos de IA, uso do proxy) | 3 |
| R7 | IA | cancelar no cliente não cancela a chamada ao provedor no servidor | 3 |
| R8 | widgets | arrastar dentro do conteúdo de um widget move o bloco (seleção de texto impossível) | 5 |
| R9 | texto | palavra longa quebra por caractere em formas estreitas | 5 |

## 5. Proteção de dados (feito nesta etapa)

- Fixtures **congeladas** em `tests/fixtures/`: `aurora-export-v3.json` (todos os tipos de elemento, grupos, frame, imagem com asset, seta multiponto) e `legacy-v03-localstorage.json` (formato real do protótipo). Gerador: `scripts/generate-fixtures.ts` — não regenerar ao mudar o esquema; criar migração.
- Lógica de gravação da importação extraída para `applyImport()` (testável) — testes provam que importar duas vezes cria quadros novos e não altera existentes nem assets.
- **Defeito confirmado e corrigido:** o esquema exigia `strokeWidth ≥ 0.5`, mas imagens são criadas com 0 → **todas as imagens eram descartadas ao importar um backup**. Reproduzido pela fixture (`data-protection.test.ts`), corrigido relaxando o mínimo para 0.
