# Desenvolvimento e testes

## Comandos

| Comando | Uso |
|---|---|
| `npm run dev` | App (5173) + servidor local (8787) com recarga |
| `npm run verify` | **Antes de cada commit**: tipos + unitários + build + E2E (Chromium) |
| `npm run typecheck` | Só TypeScript |
| `npm test` / `npm run test:watch` | Unitários (Vitest), uma vez / modo observação |
| `npm run test:e2e` | E2E no Chromium (sobe o servidor se não estiver rodando) |
| `npm run test:e2e:all` | E2E em Chromium, Firefox, WebKit e celular (Pixel 7) |
| `npm run test:e2e:mobile` | Só os cenários de celular |
| `npm run test:e2e:report` | Abre o relatório HTML da última execução |
| `npm run audit:prod` | Vulnerabilidades altas/críticas em dependências de produção |

Primeira vez: `npx playwright install chromium` (ou `firefox webkit` para os demais).

## Rodar um teste específico

```bash
npx vitest run tests/unit/persistence-stress.test.ts -t "diário"
```

```bash
npx playwright test e2e/editing.spec.ts --project=webkit -g "aninhados"
```

```bash
npx playwright test --project=chromium --headed --debug -g "multiponto"
```

## Interpretar falhas

- **Unitário** (`tests/unit/`): núcleo puro, persistência com adaptador controlado, servidor com transporte simulado. Falha aqui = regra quebrada; a mensagem do `expect` mostra o valor esperado e o recebido.
- **E2E** (`e2e/`): mouse/teclado reais. Em falha, o Playwright salva **screenshot**, **trace** e (no CI) **vídeo** em `test-results/`. Para ver passo a passo com DOM, rede e console:

```bash
npx playwright show-trace test-results/<pasta-do-teste>/trace.zip
```

- **Instabilidade × falha real**: no CI cada E2E tem **uma nova tentativa**. “flaky” no relatório = passou na segunda (investigar tempo/condição de corrida); falhou nas duas = defeito real.
- **Infraestrutura × incompatibilidade**: erros como `browserType.launch: spawn UNKNOWN` ou `Executable doesn't exist` são do ambiente (navegador não instalado/bloqueado), não do app. No Windows de desenvolvimento deste projeto o Firefox do Playwright não inicia (`spawn UNKNOWN`); ele roda no CI (Linux).

## Artefatos do CI

Em cada execução com falha, o job de E2E publica `playwright-<projeto>` com `playwright-report/` e `test-results/` (14 dias). Baixe na página da execução (Actions → execução → Artifacts), descompacte e rode `npx playwright show-report playwright-report`.

O job de build publica `dist/` (7 dias).

## Reproduzir um bug

1. Rode `npm run dev` e reproduza no navegador.
2. No console, `window.__aurora.getState()` mostra o estado completo (elementos, seleção, câmera, histórico, estado de gravação).
3. Exporte o quadro (Exportar → Este quadro) e anexe ao relato, se não houver dados sensíveis.
4. Escreva um teste que falhe:
   - lógica/geometria/persistência → `tests/unit/` (veja `persistence-stress.test.ts` para controlar a ordem das gravações);
   - interação → `e2e/` (helpers `drawShape`, `drag`, `toPage`, `state` em `e2e/helpers.ts`).
5. Corrija e confirme que o teste passa; rode `npm run verify`.

## Dados de teste

- `tests/fixtures/aurora-export-v3.json` e `legacy-v03-localstorage.json` são **congeladas**: representam dados reais antigos. Se uma mudança de esquema quebrá-las, escreva uma migração em `src/persistence/migrations.ts` — não regenere as fixtures.
- O E2E usa um contexto de navegador novo por teste (IndexedDB vazio); nunca toca nos dados do seu navegador.

## Convenções

- Branch de trabalho por ciclo (`improvement/...`); `main` só recebe merge após revisão.
- Commits descritivos por etapa; sem `.env`, `node_modules`, `dist`, `test-results`.
- Código de interface em português do Brasil; identificadores em inglês.
