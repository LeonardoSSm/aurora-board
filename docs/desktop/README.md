# Aurora Board Desktop

O Aurora Board como aplicativo instalado para **Windows 10/11 x64** e **Linux x64** (Linux Mint e distribuições compatíveis), sem iniciar Vite, Node.js ou servidor. Mesmo frontend da versão web, empacotado com Electron (issue #34, ciclo D1).

| Documento | Conteúdo |
|---|---|
| [INSTALL.md](INSTALL.md) | Instalar no Windows e no Linux Mint, primeiros passos, migrar dados, configurar a IA, testar o HTML Network Bridge |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Decisão Electron × Tauri, processos, protocolo `aurora://app`, isolamento, widgets HTML |
| [IPC.md](IPC.md) | IPC tipado, integrações no processo principal (IA, rede dos widgets, Meu Pluggy, links) |
| [DATA.md](DATA.md) | Persistência, credenciais no cofre do sistema, migração, encerramento seguro, recuperação |
| [DEVELOPMENT.md](DEVELOPMENT.md) | Desenvolvimento, build, testes no app e no executável empacotado |
| [DISTRIBUTION.md](DISTRIBUTION.md) | Instaladores, artefatos, assinatura, atualizações |
| [TROUBLESHOOTING.md](TROUBLESHOOTING.md) | Problemas comuns e diagnóstico |
| [HOMOLOGATION.md](HOMOLOGATION.md) | Critérios de homologação e o que foi efetivamente verificado em cada plataforma |
