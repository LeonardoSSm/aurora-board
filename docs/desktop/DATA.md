# Aurora Board Desktop — persistência, migração, credenciais e recuperação (D1-C)

## Onde ficam os dados

| O quê | Onde | Observação |
|---|---|---|
| Quadros, workspaces, assets (imagens, documentos, GIFs, dados importados), configurações locais e autorizações | IndexedDB `aurora-board` do perfil do app | Mesmo esquema da web |
| Finanças (razão) | IndexedDB `aurora-finance` do perfil | Separado, como na web |
| Diário de recuperação | `localStorage` do perfil | Alterações ainda não confirmadas no IndexedDB |
| Credenciais (chaves de IA, Meu Pluggy) | `credentials.json` do perfil, **cifrado pelo cofre do sistema** | Nunca no IndexedDB, em quadros ou em backups |

Perfil: `%APPDATA%\Aurora Board` (Windows) · `~/.config/Aurora Board` (Linux). **Fora** da pasta de instalação; desinstalar **não** apaga (o instalador não remove o perfil). O app pede armazenamento persistente (`navigator.storage.persist()`).

## Credenciais (cofre do sistema)

- Tela **Configurações do aplicativo** (ícone de engrenagem na barra superior; também a partir do bloco de IA e das boas-vindas): OpenAI, Anthropic/Claude, Gemini (chave e modelo) e Meu Pluggy (Client ID, Client Secret, IDs dos itens).
- O valor vai **direto ao processo principal** e nunca volta ao renderer: a tela mostra só “no cofre do sistema / só nesta sessão / variável de ambiente / não configurada”. Testado: o valor não aparece no status, no DOM nem no `localStorage`.
- **Cofre forte**: Windows → DPAPI do usuário (via `safeStorage`); Linux → Secret Service (GNOME Keyring/libsecret) ou KWallet. Se o Electron cair no back-end `basic_text` (sem cofre: chave fixa conhecida) ou a cifra não existir, **o app não grava** — “Salvar no cofre” fica desabilitado, a tela explica e oferece **“Só nesta sessão”** (memória do processo principal, some ao fechar). Nada é gravado em texto puro silenciosamente.
- Arquivo de credenciais corrompido/de outro usuário: o app abre sem chaves e avisa (“configure de novo”). Escrita atômica (temporário + renomear), permissão `0600`.
- Prioridade: valor definido no app > variável de ambiente do sistema (que continua funcionando). Remover a do app devolve a do sistema.

## Migração do navegador para o desktop

**Por exportação/importação**, nunca lendo o perfil interno do navegador.

1. No navegador: **Minhas contas → Privacidade e backups → Backup pessoal completo (quadros + finanças)** — recomendado **cifrar** com senha. Sem finanças: **Exportar → Backup do workspace**.
2. No desktop: cartão de boas-vindas **Migrar do navegador…** (ou **Importar → Migrar do navegador**), escolha o arquivo, informe a senha se cifrado, **Analisar**, **Migrar agora**.

O assistente aceita backup pessoal (cifrado ou não), backup financeiro e backup de quadros/v0.2–v0.3.

**Ordem segura:** tudo é **validado antes de gravar** (esquema e limites dos quadros, assets, dados importados, estrutura financeira, senha). Depois grava as **finanças** (só acrescenta; repetidos são ignorados) e por último os **quadros** (uma transação: todos ou nenhum; nunca sobrescrevem — entram como novos). Se os quadros falharem depois das finanças, o assistente diz isso e **repetir é seguro**.

### Inventário

| Categoria | Migra? | Como |
|---|---|---|
| Quadros, workspaces, elementos, imagens, documentos, GIFs, dados importados | ✅ | Backup pessoal / do workspace |
| Finanças (contas, movimentações, importações, categorias, regras) | ✅ | Backup pessoal / financeiro (cifra AES-GCM + PBKDF2 preservada) |
| Widgets HTML personalizados | ⚠ | Vêm nos quadros, mas **desativados**: ative cada um conscientemente |
| Autorizações locais (IA dos blocos HTML, dados importados, consultas bancárias; acesso à rede dos widgets) | ❌ | Por segurança: autorize de novo no desktop |
| Chaves de IA, credenciais do Meu Pluggy | ❌ | Nunca estão em backups: Configurações do aplicativo |
| Consentimentos de provedores financeiros | ❌ | Reconecte no desktop |
| Preferências locais (zoom, navegação, animações, larguras, favoritos radiais, Companions) | ❌ | Ficam no navegador: ajuste de novo |

## Encerramento seguro

Fechar a janela (botão, Alt+F4, menu Sair) pede ao renderer que grave as alterações pendentes e espera a confirmação. Se a gravação falhar ou o renderer não responder em 8 s, o app pergunta: **Tentar de novo / Fechar mesmo assim / Cancelar**. Mesmo fechando assim, o diário de recuperação traz de volta o que não foi gravado na próxima abertura.

## Recuperação após falhas

- **Renderer caiu:** a janela recarrega sozinha e o diário de recuperação devolve o que não tinha sido gravado (“Alterações não salvas de … foram recuperadas”). Duas quedas em 30 s → pergunta antes de insistir.
- **Renderer travado:** o app oferece esperar ou recarregar.
- **Falta de espaço / erro de gravação:** o salvamento automático mantém o diário e tenta de novo; o indicador “salvo localmente” mostra a falha (comportamento da web, `src/persistence/autosave.ts`).
- **Importação/migração:** validação completa antes e transação única para os quadros; nenhum estado parcial de quadros.
- **Operações de integração** pendentes (IA, rede, Pluggy) são canceladas quando a janela recarrega, trava ou fecha (D1-B).

## Testes

- `tests/unit/desktop-data.test.ts`: cofre (forte só com DPAPI/Secret Service/KWallet; `basic_text` recusado), cifrado em disco, valor nunca no status, reinício, “só nesta sessão”, variável do sistema e prioridade, nomes/valores/modos inválidos, arquivo corrompido; migração (plano de quadros, backup pessoal cifrado com senha certa/errada/ausente, arquivos inválidos, ordem finanças → quadros, falha e repetição seguras).
- `e2e-desktop/data.spec.ts` (app e executável empacotado): boas-vindas não bloqueiam e não voltam; credenciais (cofre do Windows, sessão, nada no renderer, persistência depois de reabrir); fechar logo após editar grava tudo; queda do renderer → recarga com dados (modo app); migração completa (quadro + conta financeira), repetição sem duplicar finanças, arquivo inválido recusado.
