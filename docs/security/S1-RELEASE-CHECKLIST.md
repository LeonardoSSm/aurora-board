# S1 — Checklist de liberação do beta público

Legenda: ✅ verificado neste ciclo (com evidência) · ⏳ pendente (depende de ação/credencial) · ⚠️ risco aceito, documentado.

## Código e testes

- ✅ `npm run typecheck`, `npm test` (466), `npm run build` verdes.
- ✅ E2E funcionais e de segurança em Chromium, Firefox (CI), WebKit e celular.
- ✅ Jornada do build público com CSP Report-Only e aplicada em 3 navegadores (`npm run test:static`, job *static*).
- ✅ `npm audit` e `npm audit --omit=dev`: 0 vulnerabilidades.
- ✅ Gitleaks no histórico completo, CodeQL `security-extended` sem bloqueios.
- ✅ Nenhum P0 aberto; P1 relevantes ao beta corrigidos ou mitigados ([matriz final](S1-REVALIDATION.md#matriz-final)).
- ✅ Backups antigos (fixtures v0.3 e v3) continuam importando; nada é sobrescrito; importação atômica.

## Build e hospedagem

- ✅ `dist/` sem `window.__aurora`, rotas `/api`, source maps ou chaves (verificado na CI).
- ✅ `public/_headers` e `vercel.json` gerados da fonte única e conferidos na CI.
- ✅ `vercel.json` com `git.deploymentEnabled: false`; nenhum workflow publica o site.
- ⏳ Criar projeto de **homologação** (Cloudflare Pages ou Vercel Preview) — exige conta do responsável.
- ⏳ Na homologação: `curl -sI` confirma cabeçalhos de `/` e `/sandbox.html`; `/api/*` → 404; `/.env`, `/server/*`, `/package.json` não servidos.
- ⏳ `AURORA_STATIC_BASE_URL=https://<homologação> npm run test:static` verde nos 3 navegadores.
- ⏳ Teste manual em celular real (Android e iOS): importar, ativar HTML, exportar, recarregar.
- ⏳ HTTPS e HSTS confirmados no domínio final (decidir sobre `preload` — irreversível na prática).
- ⏳ Habilitar *Private vulnerability reporting* no GitHub (Settings › Security) para o canal de reporte citado nos docs.
- ⏳ Proteção da branch `main` exigindo os jobs da CI (configuração do repositório, fora do alcance deste ciclo).

## Produto

- ✅ Avisos: armazenamento local, backup, IA indisponível, importação de terceiros.
- ✅ HTML importado desativado por padrão; ativação consciente.
- ⚠️ Prévia de PDF desativada (só download).
- ⚠️ Phishing visual possível dentro de widget HTML **depois** de ativado pelo usuário.
- ⏳ Revalidação independente (Raven ou outra auditoria) sobre esta branch.
- ⏳ **Decisão de publicação** pelo responsável do projeto. Merge na `main` não é autorização de lançamento.

## Não incluído no beta (não ativar)

- Servidor Node/IA exposto à internet (modelo C — exige ciclo próprio).
- Variáveis `VITE_AURORA_LOCAL_API` / `VITE_AURORA_TEST_HOOKS` na hospedagem.
