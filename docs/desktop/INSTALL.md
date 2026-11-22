# Instalar e usar o Aurora Board Desktop

> Os pacotes atuais são **builds de teste NÃO assinados** (`…-unsigned`). O Windows pode mostrar “O Windows protegeu o computador” (SmartScreen): clique em **Mais informações → Executar assim mesmo** só se o arquivo veio do repositório oficial (Actions do GitHub ou um build seu). Ver [DISTRIBUTION.md](DISTRIBUTION.md).

## Onde baixar

Em **GitHub → Actions → CI** (execução da `main`), seção *Artifacts*:
- `aurora-board-windows-x64-unsigned` → `Aurora-Board-<versão>-win-x64-unsigned.exe`
- `aurora-board-linux-x64-unsigned` → `Aurora-Board-<versão>-linux-amd64-unsigned.deb` e `…-linux-x86_64-unsigned.AppImage`

Ou gere localmente: `npm ci && npm run dist:desktop` (pacotes da plataforma atual em `release/`).

## Windows 10/11 (x64)

1. Execute `Aurora-Board-<versão>-win-x64-unsigned.exe`.
2. O instalador é **por usuário**: não pede administrador. Você pode trocar a pasta de instalação.
3. Atalhos: menu Iniciar e área de trabalho (“Aurora Board”).
4. Dados: `%APPDATA%\Aurora Board` — **fora** da pasta de instalação. Desinstalar (Configurações → Aplicativos, ou “Uninstall Aurora Board.exe”) **não** apaga seus quadros; para apagar tudo, remova essa pasta depois.

Instalação silenciosa (administração/testes): `Aurora-Board-<versão>-win-x64-unsigned.exe /S /currentuser /D=C:\Caminho\Aurora Board` (o `/D=` sem aspas e por último).

## Linux Mint (e Ubuntu/Debian x64)

**Recomendado: `.deb`.**

```bash
sudo apt install ./Aurora-Board-<versão>-linux-amd64-unsigned.deb
```

- Instala em `/opt/Aurora Board/`, com atalho no menu (Escritório → Aurora Board) e o comando `aurora-board`. A instalação configura o sandbox do Chromium (perfil AppArmor no Mint 22/Ubuntu 24+).
- **Use sem root.** O root só é necessário para instalar o pacote.
- Dados: `~/.config/Aurora Board`.
- Credenciais: para guardar chaves de IA com segurança, o Linux Mint usa o **GNOME Keyring (Secret Service)**, que já vem ativo na sessão Cinnamon. Sem cofre, o app só aceita chaves “nesta sessão”.
- Remover: `sudo apt remove aurora-board` (seus dados em `~/.config` ficam).

**AppImage (alternativa sem instalar):**

```bash
chmod +x Aurora-Board-<versão>-linux-x86_64-unsigned.AppImage
./Aurora-Board-<versão>-linux-x86_64-unsigned.AppImage
```

Precisa do `libfuse2` (`sudo apt install libfuse2`). Em sistemas com a restrição de namespaces do AppArmor (Ubuntu 24.04+), o AppImage pode não abrir: use o `.deb` (ver [TROUBLESHOOTING.md](TROUBLESHOOTING.md)).

## Primeiros passos

Na primeira abertura, um cartão de boas-vindas (não bloqueia o quadro) oferece **Migrar do navegador** e **Configurar IA**.

### Migrar seus dados do navegador

1. No navegador, abra o Aurora Board → **Minhas contas → Privacidade e backups → Backup pessoal completo** (marque cifrar e anote a senha).
2. No desktop → **Migrar do navegador…** (boas-vindas, menu Arquivo ou Importar) → escolha o arquivo → senha → **Analisar** → **Migrar agora**.
3. Quadros e finanças entram como **novos** (nada é sobrescrito). Widgets HTML chegam desativados; autorizações de IA/rede e chaves não migram — autorize/configure de novo. Detalhes: [DATA.md](DATA.md#migração-do-navegador-para-o-desktop).

### Configurar a IA

Engrenagem **Configurações do aplicativo** (barra superior ou menu Arquivo): cole a chave da OpenAI, Anthropic (Claude) ou Gemini → **Salvar no cofre** (Windows: DPAPI; Linux: Secret Service/KWallet) ou **Só nesta sessão**. A chave nunca volta para a tela nem vai para backups. Depois adicione um bloco de IA e conecte blocos ao contexto, como na web.

Meu Pluggy: Client ID, Client Secret e IDs dos itens na mesma tela (somente leitura; ver docs/finance).

### Testar o HTML Network Bridge

1. Biblioteca → **HTML isolado** → Propriedades → Exemplos → **Dashboard público: repositório do GitHub (aurora.request)** → Usar.
2. Clique **Atualizar** no bloco → confirme o acesso a `https://api.github.com` (**Permitir sempre** ou **uma vez**).
3. As estrelas/forks/issues aparecem; Propriedades → **Acesso à rede** mostra destino, método, última consulta (sem o caminho) e permite **Revogar**.

Tudo passa pelo processo principal do app (sem servidor HTTP): mesmas proteções da web (só GET/HTTPS, sem rede local, dados sensíveis exigem autorização específica).

## Atalhos

Os atalhos do canvas são os da web (veja **?** na barra superior). O menu nativo não registra atalhos que colidam com o canvas (Ctrl+Z/Y/C/V/A, +/−…). Tela cheia: menu Exibir.
