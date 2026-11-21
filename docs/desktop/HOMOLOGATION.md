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

## Evidência da CI (ciclo D1)

Jobs do workflow `CI` no repositório, todos sem `continue-on-error`:

| Job | O que comprova | Última execução verde no ciclo |
|---|---|---|
| Desktop (Electron, Windows — app, pacote e instalador) | app montado + executável empacotado (critérios 1–5, 7–11) + instalação NSIS silenciosa, app **instalado** aberto, desinstalação preservando `%APPDATA%\Aurora Board`, reinstalação (12) | commit `72318e4` (job 136985697006) |
| Desktop (Linux — AppImage e .deb instalados) | `.deb` gerado e **instalado com `sudo dpkg -i`** no Ubuntu 24.04, sandbox configurado pela pós-instalação (perfil AppArmor), testes no app instalado sem root; AppImage executado | commit `72318e4` (job 136985697039) |
| Desktop (Electron, Linux) | app montado no contêiner fixado da CI (sem sandbox do SO: `AURORA_DESKTOP_NO_SANDBOX=1` só ali) | commit `72318e4` (job 136985696970) |
| Build de produção (público) / Build público + CSP | build web sem `/api` e sem ponte desktop (13) | idem |

## Não verificado (limitações declaradas)

- **Linux Mint**: nenhum teste em Mint real. Base inferida: Ubuntu 24.04 (Mint 22) + `.deb`.
- **Recuperação após queda do renderer no Linux**: não verificada. No contêiner sem sandbox (app montado) a queda forçada trava o Electron e o teste é pulado ali; no job do pacote instalado o teste não roda (precisa do processo principal, que o harness por CDP não alcança). Verificada no Windows (local e CI, app montado).
- **Cofre de credenciais no Linux com Secret Service/KWallet reais**: a CI não tem chaveiro de sessão; lá o app detecta `basic_text`, recusa gravar e oferece “só nesta sessão” (comportamento verificado). A gravação cifrada real no Linux não foi exercitada.
- **Assinatura de código**: instaladores **não assinados** (SmartScreen avisa no Windows). Sem atualização automática.
- **HTML Network Bridge ao vivo no Linux**: o teste ao vivo (`AURORA_LIVE=1`) foi executado só no Windows.
