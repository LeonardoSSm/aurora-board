# Aurora Board Desktop — critérios de homologação (D1)

Uma versão do desktop só é considerada homologada numa plataforma quando **todos** os itens abaixo foram verificados **no aplicativo empacotado/instalado** daquela plataforma — testes do Vite não contam.

## Critérios

| # | Critério | Como verificar |
|---|---|---|
| 1 | Abre sem terminal, sem Vite/Node/servidor, em `aurora://app` | `e2e-desktop/desktop.spec.ts` no executável empacotado |
| 2 | Renderer sem Node, `contextIsolation`, sandbox, CSP do app e do sandbox | idem + `webPreferences` (modo app) |
| 3 | Navegação/janelas/permissões bloqueadas; links externos no navegador do sistema | idem |
| 4 | Widget HTML isolado: sem ponte desktop, sem acesso ao pai, sem rede direta | idem |
| 5 | IPC: allowlist, recusas, cancelamento; integrações no processo principal | `e2e-desktop/integrations.spec.ts`, `tests/unit/desktop-ipc.test.ts` |
| 6 | HTML Network Bridge ao vivo (API pública real) e autorização persistente | `AURORA_LIVE=1 … e2e-desktop/live.spec.ts` |
| 7 | Persistência após fechar/reabrir; fechar logo após editar não perde nada | `desktop.spec.ts`, `data.spec.ts` |
| 8 | Credenciais: cofre forte ou recusa explícita; valor nunca no renderer | `data.spec.ts`, `tests/unit/desktop-data.test.ts` |
| 9 | Migração por backup pessoal (quadros + finanças), repetição segura | `data.spec.ts` |
| 10 | Recuperação após queda do renderer | `data.spec.ts` (modo app) |
| 11 | Menu nativo e estado da janela; atalhos do canvas preservados | `e2e-desktop/ux.spec.ts` (modo app) |
| 12 | Instalar, abrir o app **instalado**, desinstalar preservando dados | `e2e-desktop/install.spec.ts` (CI descartável) |
| 13 | Build público web inalterado (sem `/api`, sem ponte desktop) | job “Build de produção (público)” + `e2e/static` |

## Resultados

Ver a tabela de verificação na issue #34 e o relatório final do ciclo. Resumo por plataforma:

- **Windows 11 x64 (máquina de desenvolvimento):** critérios 1–11 e 13 verificados localmente no app montado **e** no executável empacotado (`release/win-unpacked`), incluindo o critério 6 ao vivo (api.github.com). O instalador NSIS foi gerado; a instalação real (12) é feita na CI, para não alterar o computador do usuário.
- **Windows (runner `windows-latest` da CI):** 1–5, 7–12 a cada push/PR (job “Desktop (Electron, Windows — app, pacote e instalador)”).
- **Linux:** sem máquina Linux física/VM nesta homologação. CI: app montado em contêiner (job “Desktop (Electron, Linux)”) e **pacote `.deb` instalado** + AppImage no runner Ubuntu 24.04 (job “Desktop (Linux — AppImage e .deb instalados)”). **Linux Mint não foi testado diretamente** — a compatibilidade é inferida da base Ubuntu 24.04 (Mint 22) e do formato `.deb`; recomenda-se um teste manual em Mint antes de divulgar.
