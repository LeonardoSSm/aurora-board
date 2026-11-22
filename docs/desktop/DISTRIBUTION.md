# Aurora Board Desktop — distribuição, assinatura e atualizações

## Artefatos

| Plataforma | Formato | Arquivo | Decisão |
|---|---|---|---|
| Windows 10/11 x64 | Instalador NSIS (assistido, por usuário, sem administrador; escolha de pasta; atalhos no menu Iniciar e área de trabalho) | `Aurora-Board-<v>-win-x64-unsigned.exe` | Formato convencional do Windows; desinstalação pelo Painel/Configurações; dados preservados |
| Linux x64 (Mint, Ubuntu, Debian) | `.deb` | `Aurora-Board-<v>-linux-amd64-unsigned.deb` | **Recomendado** para Linux Mint: integra ao menu e configura o sandbox do Chromium na instalação — perfil AppArmor no Ubuntu 24+/Mint 22 (compatível com a restrição de namespaces) ou o auxiliar SUID em sistemas sem namespaces de usuário; atualiza pelo `apt` |
| Linux x64 | AppImage | `Aurora-Board-<v>-linux-x86_64-unsigned.AppImage` | Portátil, sem instalação; depende de `libfuse2` e de namespaces de usuário para o sandbox |

Configuração única: `electron-builder.yml` (entrada `desktop-app/`, saída `release/`). O pacote leva só `main.cjs`, `preload.cjs`, `package.json` (sem dependências) e o frontend (`renderer/`) num `app.asar` de ≈2 MB, com integridade de ASAR registrada no executável.

### CI de empacotamento

- **Desktop (Electron, Windows — app, pacote e instalador)**: build, testes no app, instalador NSIS + pasta, testes no executável empacotado, **instalação silenciosa real** (por usuário, pasta temporária), abertura do app instalado com o perfil padrão, desinstalação (dados preservados) e reinstalação; publica o instalador como artefato (14 dias).
- **Desktop (Linux — AppImage e .deb instalados)**: build, AppImage + `.deb`, metadados do `.deb`, **`sudo dpkg -i`**, conferência do sandbox configurado (perfil AppArmor, SUID ou namespaces), testes no app **instalado** sem root e com o sandbox do sistema; AppImage extraído e testado com sandbox por namespaces; publica os pacotes como artefatos.
- Nenhum job publica releases. Nada de `continue-on-error`.

## Assinatura (não configurada — builds marcados como `unsigned`)

Não há certificados neste repositório e nenhum foi inventado. Para assinar versões futuras:

**Windows (Authenticode):** obtenha um certificado de assinatura de código (OV/EV). Em uma máquina/CI segura, defina como *secrets* (nunca no repositório):
- `CSC_LINK` (arquivo .pfx em base64 ou caminho) e `CSC_KEY_PASSWORD`, ou `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`;
- com EV/HSM em nuvem, use `win.signtoolOptions`/`azureSignOptions` do electron-builder.
Remova `-unsigned` do `artifactName` (ex.: `npx electron-builder --win --config.artifactName='Aurora-Board-${version}-${os}-${arch}.${ext}'`) só para builds efetivamente assinados.

**Linux:** pacotes `.deb` podem ser assinados com GPG ao publicar num repositório APT (`reprepro`/`aptly`); o AppImage pode levar assinatura GPG embutida (`--sign` do appimagetool). Publique a chave pública por um canal separado.

## Atualizações (não habilitadas)

O app **não** se atualiza sozinho — nenhuma atualização remota insegura. A arquitetura está pronta para:

1. Assinar os builds (acima).
2. Publicar releases imutáveis (ex.: GitHub Releases) com `latest.yml`/`latest-linux.yml` e `.blockmap` (o electron-builder já gera o blockmap do instalador).
3. Adicionar `electron-updater` no processo principal com verificação de assinatura do Windows (`publisherName`) e canal HTTPS fixo; checagem só com consentimento do usuário; nunca baixar de URL vinda do renderer.
4. Linux `.deb`: preferir um repositório APT assinado (atualização pelo sistema). AppImage: `AppImageUpdate` com zsync assinado.

Até lá, atualizar = instalar a versão nova por cima (Windows) ou `sudo apt install ./novo.deb` (Linux). Os dados ficam no perfil do usuário e são preservados.

## Versão

`package.json` → `version` é a versão do app (`app.getVersion()`, nome dos artefatos, menu Ajuda).

### Identificar a origem do download

Os artefatos Actions expiram após 14 dias. Antes de distribuir um instalador, confira o SHA e a branch da execução: um artefato de PR é de homologação daquela revisão; para entregar a versão integrada, prefira a execução **push da `main` após o merge**, com os jobs de desktop concluídos. O número `1.0.0` no arquivo não distingue builds de commits diferentes.

O [PR #41](https://github.com/LeonardoSSm/aurora-board/pull/41) e a [issue #34](https://github.com/LeonardoSSm/aurora-board/issues/34) registram os links da execução e dos instaladores verificados na conclusão do D1. Não há GitHub Release publicado por esse fluxo.
