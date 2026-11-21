# Aurora Board Desktop — problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| Windows: “O Windows protegeu o computador” | Build de teste **não assinado** (SmartScreen) | Confirme a origem do arquivo; “Mais informações → Executar assim mesmo”. Ver DISTRIBUTION.md › Assinatura |
| Abrir o atalho de novo não abre outra janela | Instância única (evita dois processos no mesmo perfil) | A janela existente é trazida para a frente |
| AppImage não abre no Ubuntu 24.04+ (“SUID sandbox helper … not configured correctly”) | Restrição de namespaces de usuário do AppArmor | Use o `.deb` (instala o auxiliar SUID). Não rode com `--no-sandbox` |
| AppImage: “dlopen(): error loading libfuse.so.2” | Falta FUSE 2 | `sudo apt install libfuse2` ou use o `.deb` |
| “Sem cofre seguro do sistema” nas Configurações (Linux) | Sem Secret Service/KWallet na sessão (ex.: sessão mínima, i3 sem keyring) | Instale/inicie o GNOME Keyring (`gnome-keyring`) ou KWallet e reabra o app; ou use “Só nesta sessão” |
| “Há credenciais gravadas, mas o cofre … não está disponível” | Keyring bloqueado ou outro usuário/perfil | Desbloqueie o chaveiro e reabra; ou configure de novo |
| IA: “não configurado” | Nenhuma chave no app nem no ambiente | Configurações do aplicativo → chave → Salvar no cofre |
| HTML Network Bridge: `local_only` | Não acontece no desktop (sem pareamento LAN) | — |
| HTML Network Bridge: `blocked_address` / `dns_error` | Destino resolve para rede local/reservada, ou não existe | Por design: só APIs públicas |
| Fechou com pergunta “Algumas alterações ainda não foram gravadas” | Gravação falhou (disco cheio, permissão) ou o app travou | “Tentar de novo”; se fechar mesmo assim, o diário de recuperação devolve as alterações na próxima abertura |
| A janela recarregou sozinha | O processo de renderização caiu | Os dados gravados continuam; alterações do diário são recuperadas (aviso na tela) |
| Janela abre fora da tela | Monitor removido | O app detecta e centraliza no monitor principal; se persistir, apague `window-state.json` do perfil |
| Migração: “Quadros recusados” | Arquivo alterado, versão futura ou fora dos limites | Gere o backup de novo no navegador; nada foi gravado |
| Migração: senha incorreta | Backup cifrado | Use a senha definida ao exportar (não há recuperação) |

## Onde estão as coisas

| Windows | Linux | O quê |
|---|---|---|
| `%APPDATA%\Aurora Board\` | `~/.config/Aurora Board/` | Perfil: IndexedDB, `localStorage`, `credentials.json` (cifrado), `window-state.json` |
| pasta escolhida na instalação (padrão `%LOCALAPPDATA%\Programs\Aurora Board`) | `/opt/Aurora Board/` | Programa |

## Diagnóstico

- **Logs do processo principal:** rode pelo terminal (`"%LOCALAPPDATA%\Programs\Aurora Board\Aurora Board.exe"` ou `aurora-board`) e veja a saída. Não há logs de conteúdo do usuário nem de URLs consultadas.
- **Ferramentas de desenvolvimento:** `AURORA_DESKTOP_DEVTOOLS=1` (só para diagnóstico; dá acesso total à página).
- **Perfil limpo para testar:** `AURORA_USER_DATA_DIR=<pasta vazia>`.
- **Reproduzir os testes:** `npm run build:desktop && npm run test:desktop` (ou com `AURORA_DESKTOP_EXECUTABLE=<executável>`).
