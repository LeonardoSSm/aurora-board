# Desenvolvimento e testes

## Comandos

| Comando | Uso |
|---|---|
| `npm run dev` | App (5173) + servidor local (8787) com recarga |
| `npm run dev:lan` | App acessível na rede local (5174) com **pareamento de computadores** ligado; requer `npm run dev` rodando (ver docs/SECURITY.md › Computadores pareados) |
| `npm run verify` | **Antes de cada commit**: tipos + unitários + build + E2E (Chromium) |
| `npm run typecheck` | Só TypeScript |
| `npm test` / `npm run test:watch` | Unitários (Vitest), uma vez / modo observação |
| `npm run test:e2e` | E2E no Chromium (sobe o servidor se não estiver rodando) |
| `npm run test:e2e:all` | E2E em Chromium, Firefox, WebKit e celular (Pixel 7) |
| `npm run test:e2e:mobile` | Só os cenários de celular |
| `npm run test:e2e:report` | Abre o relatório HTML da última execução |
| `npm run audit:prod` | Vulnerabilidades altas/críticas em dependências de produção |
| `npm run audit:full` | Auditoria completa (todas as dependências), falha em altas/críticas |
| `npm run test:security` | Testes de segurança do ciclo S1 (unitários + `e2e/security.spec.ts` no Chromium) |
| `npm run test:static` | Build **público** + `vite preview` com os cabeçalhos da hospedagem + jornada `e2e/static` (CSP aplicada). `AURORA_CSP_MODE=report-only` para a fase de relatório; `AURORA_STATIC_BASE_URL=https://…` para rodar contra uma homologação |
| `npm run hosting:generate` | Regenera `public/_headers` e `vercel.json` a partir de `hosting/headers.ts` (a CI falha se estiverem desatualizados) |
| `npm run perf` | Benchmark contra build de produção com `VITE_AURORA_TEST_HOOKS=1` |
| `npm run test:finance` | Finanças pessoais (ciclo F1): unitários `tests/unit/finance-*.test.ts` + jornadas A–H de `e2e/finance.spec.ts` no Chromium |
| `npm run perf:gifs` | Benchmark de pan/zoom com 0, 25 e 100 GIFs animados (`PERF_GIFS=…`) |
| `npm run perf:finance` | Benchmark do razão financeiro (100 a 50.000 movimentações; `PERF_SIZES=…` para mudar) |

Primeira vez: `npx playwright install chromium` (ou `firefox webkit` para os demais).

## Movimento da câmera nos testes

O `playwright.config.ts` usa `reducedMotion: 'reduce'`: a câmera vai direto ao destino, e os testes antigos podem ler a câmera logo após uma ação. Testes de câmera e checkpoints ativam a animação com `test.use({ reducedMotion: 'no-preference' })` e esperam o fim com `__aurora.core.isCameraAnimating()`. Nos testes unitários, `__setCameraTestHooks(relógio, true)` injeta um relógio manual.

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

## Navegadores na CI (ciclo CI-1, #25)

Os jobs `E2E (…)` e `Build público + CSP (…)` rodam **dentro da imagem oficial do Playwright**, fixada por versão **e** digest em `.github/workflows/ci.yml`:

```yaml
container:
  image: mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc…f525579
  options: --user 1001
```

- A imagem já traz Chromium, Firefox, WebKit, ffmpeg e todas as dependências nativas. A CI **não** roda `playwright install --with-deps` (nem apt) por execução.
- `--user 1001` é o uid do usuário `runner` do host: o workspace e o `HOME` montados pertencem a ele (o Firefox recusa rodar como root com `HOME` de outro dono) e os testes não rodam como root.
- Antes dos testes, `scripts/ci/check-playwright-browsers.mjs <projeto>` confere se os diretórios de navegador que o `playwright-core` do lockfile espera (`browsers.json`) existem em `PLAYWRIGHT_BROWSERS_PATH`. Se a imagem e o lockfile divergirem, o job falha em segundos com a instrução de correção, em vez de cada teste falhar com `Executable doesn't exist`.
- `tests/unit/ci-workflow.test.ts` protege o contrato: imagem com digest, mesma versão do `@playwright/test`/`playwright-core` do lockfile nos dois jobs, nenhum `playwright install`/`--with-deps`/apt, os 4 projetos E2E e os 3 navegadores do build público (fases report-only e enforce da CSP), demais jobs intactos e actions fixadas por SHA.

**Por quê.** No ciclo L1 (#22/PR #23), 5 jobs WebKit foram cancelados por timeout no passo `playwright install --with-deps webkit`. Os logs mostraram que o `ubuntu-latest` (Ubuntu 26.04) precisa baixar 185 pacotes / 140 MB do espelho `azure.archive.ubuntu.com` para o WebKit (Chromium: 21,9 MB; Firefox: 54,4 MB) e que, em certos runners (todos os travados eram de westus2), o download caía para ~50 kB/s — o apt não tem timeout de vazão, então o job só morria no timeout. Nas reexecuções o mesmo download levava 3 s. O cache de `~/.cache/ms-playwright` não ajudava: guarda os binários, não as bibliotecas do sistema. Diagnóstico completo na issue #25.

**Atualizar o Playwright** (o Dependabot abre um PR próprio para `@playwright/test`, grupo `playwright` em `.github/dependabot.yml`):

1. Suba `@playwright/test` no `package.json`/lockfile (o `playwright-core` acompanha).
2. Troque a tag nos **dois** jobs (`e2e` e `static`) para `vX.Y.Z-noble` com a mesma versão.
3. Fixe o digest do índice multi-arquitetura da tag nova:
   ```bash
   curl -sI -H "Accept: application/vnd.oci.image.index.v1+json" https://mcr.microsoft.com/v2/playwright/manifests/vX.Y.Z-noble | grep -i docker-content-digest
   ```
4. `npx vitest run tests/unit/ci-workflow.test.ts` deve passar; a CI confirma o resto.

Limitações: a imagem tem ~1 GB comprimido e é baixada do MCR a cada job (CDN da Microsoft, independente do espelho apt; tipicamente menos de 1 min). Uma degradação do MCR ainda pode atrasar um job — nesse caso o tempo aparece em "Initialize containers", não nos testes. A imagem é Ubuntu 24.04 (noble), enquanto o host é 26.04: os navegadores rodam no ambiente da imagem, que é o suportado oficialmente pelo Playwright.

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

## Builds e ganchos de teste (ciclo S1)

- `npm run build` gera o **build público**: sem `window.__aurora`, sem chamadas a `/api` (IA e prévia de links aparecem como indisponíveis). É o que vai para a hospedagem.
- Builds locais podem ligar, **no build** (nunca por URL ou storage): `VITE_AURORA_LOCAL_API=1` (usar o servidor local) e `VITE_AURORA_TEST_HOOKS=1` (expor `window.__aurora`, usado pelo benchmark).
- Os E2E comuns rodam contra `npm run dev`, onde `window.__aurora` existe. Os E2E de `e2e/static/` usam só a interface (o build público não tem os ganchos).
- Widgets HTML rodam em `public/sandbox.html` (documento próprio). Se mudar sua CSP, atualize `SANDBOX_CSP` (`sandbox.tsx`) e `SANDBOX_CSP_BASE` (`hosting/headers.ts`) — `tests/unit/hosting.test.ts` garante que os três batem.
- Testes de segurança usam só dados fictícios e nenhum servidor externo; segredos de exemplo nos testes são marcados como fictícios e liberados no `.gitleaks.toml` apenas para `tests/unit/*.test.ts`.
