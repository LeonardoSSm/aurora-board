# Aurora Board Desktop — desenvolvimento, build e testes

## Pré-requisitos

Node 24, `npm ci` (baixa o Electron fixado: 45.4.1). Em CI, os jobs que não usam o desktop pulam o download (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`).

## Comandos

| Comando | O que faz |
|---|---|
| `npm run build:desktop` | Frontend com `VITE_AURORA_DESKTOP=1` + processo principal e preload (esbuild) em `desktop-app/` |
| `npm run desktop` | Build e abre o app (`electron desktop-app`) |
| `npm run test:desktop` | Testes Playwright no **app Electron** (`e2e-desktop/`) |
| `AURORA_DESKTOP_EXECUTABLE=<exe> npm run test:desktop` | Os mesmos testes no **executável empacotado** |
| `npx electron-builder --config electron-builder.yml --win --dir` | Pacote sem instalador em `release/win-unpacked/` |
| `npm run dist:desktop` | Build + pacotes da plataforma atual em `release/` (ver DISTRIBUTION.md) |
| `node scripts/desktop/make-icons.mjs` | Regenera os ícones a partir de `public/favicon.svg` |

`desktop-app/` e `release/` são gerados (fora do git). `desktop-app/package.json` é um manifesto mínimo **sem dependências**: tudo vai embutido nos bundles, então o pacote não leva `node_modules` (≈2 MB de `app.asar`).

## Variáveis de ambiente (desenvolvimento/testes)

| Variável | Efeito |
|---|---|
| `AURORA_USER_DATA_DIR` | Pasta do perfil (dados) — testes e uso portátil |
| `AURORA_DESKTOP_DEVTOOLS=1` | Liga as DevTools no pacote (os testes precisam do protocolo de depuração) |
| `AURORA_DESKTOP_NO_SANDBOX=1` | **Só testes em contêiner Linux** (CI): passa `--no-sandbox`. O sandbox do renderer (`webPreferences.sandbox`) continua ligado |

## Como os testes abrem o app

`e2e-desktop/harness.ts`: no modo padrão usa `electron.launch` (acesso ao processo principal para conferir `webPreferences` e simular o navegador do sistema). Com `AURORA_DESKTOP_EXECUTABLE`, inicia o executável empacotado e conecta pelo protocolo de depuração do Chromium — o `electron.launch` do Playwright não consegue anexar a executáveis empacotados sem o carregador dele. Cada teste usa um perfil temporário próprio; o perfil real do usuário nunca é tocado.

Os testes do Vite (`npm run test:e2e`) **não** comprovam o app instalado: os do desktop rodam no Electron.

## CI

- **Desktop (Electron, Linux)**: imagem fixada do Playwright, `xvfb-run`, app montado. O contêiner não oferece namespaces de usuário ao sandbox do SO, então só ali os testes usam `--no-sandbox`.
- **Desktop (Electron, Windows — app e pacote)**: app montado **e** executável empacotado (`--dir`), com o sandbox do SO.
