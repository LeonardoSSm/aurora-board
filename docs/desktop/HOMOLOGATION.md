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

- **Windows 11 x64 (máquina de desenvolvimento):** app montado e executável empacotado (`release/win-unpacked`) exercitados com perfis temporários; HTML Network Bridge ao vivo (api.github.com) no pacote. Os testes que precisam controlar o processo principal (menu nativo, posição da janela, queda do renderer e fechar com texto ainda em edição) rodam somente no app montado: o harness do pacote usa CDP e pula esses casos. O instalador NSIS foi gerado; a instalação real (12) é feita na CI, para não alterar o computador do usuário.
- **Windows (runner `windows-latest` da CI):** 1–5, 7–12 a cada push/PR (job “Desktop (Electron, Windows — app, pacote e instalador)”).
- **Linux:** sem máquina Linux física/VM nesta homologação. CI: app montado em contêiner (job “Desktop (Electron, Linux)”) e **pacote `.deb` instalado** + AppImage no runner Ubuntu 24.04 (job “Desktop (Linux — AppImage e .deb instalados)”). **Linux Mint não foi testado diretamente** — a compatibilidade é inferida da base Ubuntu 24.04 (Mint 22) e do formato `.deb`; recomenda-se um teste manual em Mint antes de divulgar.

## Evidência da CI (ciclo D1)

Jobs do workflow `CI` no repositório, todos sem `continue-on-error`:

| Job | O que comprova | Baseline verificado antes dos P2 |
|---|---|---|
| Desktop (Electron, Windows — app, pacote e instalador) | app montado + executável empacotado (critérios 1–5, 7–11) + instalação NSIS silenciosa, app **instalado** aberto, desinstalação preservando `%APPDATA%\Aurora Board`, reinstalação (12) | [`40b4b7a`, job 137001761682](https://github.com/LeonardoSSm/aurora-board/actions/runs/44955126258/job/137001761682) |
| Desktop (Linux — AppImage e .deb instalados) | `.deb` gerado e **instalado com `sudo dpkg -i`** no Ubuntu 24.04, sandbox configurado pela pós-instalação (perfil AppArmor), testes no app instalado sem root; AppImage executado | [`40b4b7a`, job 137001761596](https://github.com/LeonardoSSm/aurora-board/actions/runs/44955126258/job/137001761596) |
| Desktop (Electron, Linux) | app montado no contêiner fixado da CI (sem sandbox do SO: `AURORA_DESKTOP_NO_SANDBOX=1` só ali) | [`40b4b7a`, job 137001761548](https://github.com/LeonardoSSm/aurora-board/actions/runs/44955126258/job/137001761548) |
| Build de produção (público) / Build público + CSP | build web sem `/api` e sem ponte desktop (13) | idem |

## Não verificado (limitações declaradas)

- **Linux Mint**: nenhum teste em Mint real. Base inferida: Ubuntu 24.04 (Mint 22) + `.deb`.
- **Recuperação após queda do renderer no Linux**: não verificada. No contêiner sem sandbox (app montado) a queda forçada trava o Electron e o teste é pulado ali; no job do pacote instalado o teste não roda (precisa do processo principal, que o harness por CDP não alcança). Verificada no Windows (local e CI, app montado).
- **Cofre de credenciais no Linux com Secret Service/KWallet reais**: a CI não tem chaveiro de sessão; lá o app detecta `basic_text`, recusa gravar e oferece “só nesta sessão” (comportamento verificado). A gravação cifrada real no Linux não foi exercitada.
- **Assinatura de código**: instaladores **não assinados** (SmartScreen avisa no Windows). Sem atualização automática.
- **HTML Network Bridge ao vivo no Linux**: o teste ao vivo (`AURORA_LIVE=1`) foi executado só no Windows.

## Retomada do PR #41 — 2026-11-21

O checkout recebido estava limpo em `40b4b7a`, na branch `feature/d1d-desktop-dist`, com reflog apenas do clone, sem stash nem outro worktree. O remoto ainda apontava para esse commit. As correções P2 descritas no handoff não foram encontradas nos diretórios locais relacionados consultados; não é possível afirmar que foram recuperadas. Conforme autorização do responsável, somente os dois P2 foram reconstruídos sobre a implementação existente, preservando D1-A/B/C e a distribuição D1-D. Não havia mutação temporária ao assumir este checkout.

### Evidência executada na retomada

| Verificação | Resultado local |
|---|---|
| Suíte original antes da correção | 1.016 testes unitários aprovados |
| Tipos e builds web/desktop | Aprovados |
| Suíte com regressões | 1.027 testes em 53 arquivos aprovados |
| E2E web Chromium | 166 aprovados, 1 captura opcional de documentação pulada |
| `tests/unit/desktop-import.test.ts` + `desktop-menu.test.ts` | 11 testes aprovados; remetente, argumentos, cancelamento, concorrência, leitura limitada, descritor fechado e erros sem caminhos privados |
| Electron montado | 18 aprovados, 3 pulados: instalação Windows/Linux restrita à CI e teste ao vivo não habilitado nessa execução |
| Executável Windows empacotado, com `AURORA_LIVE=1` | 12 aprovados, 9 pulados: 2 de instalação e 7 que exigem acesso ao processo principal. Inclui IPC, sandbox, DPAPI, persistência, migração, importação pela interface e GitHub real com autorização persistente |
| NSIS Windows x64 | Gerado localmente, sem assinatura; não instalado no perfil real do usuário |
| Auditoria npm | Produção: zero vulnerabilidades. Árvore completa: 6 moderadas ligadas ao empacotamento (`minimatch`); nenhuma alta/crítica |

As falhas iniciais de infraestrutura (DNS/loopback bloqueados pelo sandbox e ausência dos binários Electron/Chromium) são distintas dos resultados funcionais. Dependências foram instaladas a partir do lockfile, sem alterar versões.

### Regressão e mutação

- No build original, a importação pelo menu sem ativação não abriu a confirmação e Configurações substituiu a migração ativa.
- A sonda de ativação usa CDP com `userGesture: false`; `page.evaluate` daria ativação artificial e invalidaria a reprodução.
- Remover temporariamente `blocked()` da guarda fez o teste de diálogo falhar. Restaurar a guarda fez os 3 testes de menu passarem.
- Trocar temporariamente a importação nativa pelo antigo `pickImportFile()` fez o E2E sem ativação falhar. A fonte foi restaurada byte a byte em `finally`, o build correto foi reconstruído e a suíte Electron passou novamente.
- Todas as mutações foram removidas. Testes pulados por falta de acesso ao main agora pulam **antes** de abrir o pacote, evitando processos abandonados.

### Segurança e rastreabilidade

Na inspeção autenticada anterior ao envio das correções, a `main` tinha **21 alertas CodeQL abertos (16 altos e 5 médios)** e **zero alertas de segredos**. São alertas preexistentes em código, testes e no protótipo de referência; não foram descartados nem classificados em bloco como falsos positivos. Dependabot Alerts estava desabilitado; a auditoria npm e os PRs de atualização existentes são controles separados. Nenhuma configuração de segurança foi alterada.

Resultados da CI, revisão, SHA integrado e links dos artefatos finais devem ser conferidos no [PR #41](https://github.com/LeonardoSSm/aurora-board/pull/41) e na [issue #34](https://github.com/LeonardoSSm/aurora-board/issues/34). CI/CodeQL verde no PR não significa que o repositório inteiro tem zero alertas. Linux Mint real, cofre Linux real, assinatura e atualização verificada continuam pendentes; não declarar homologação completa nessas condições.
