# Aurora Board Desktop — arquitetura e decisão tecnológica (D1)

Issue #34. O aplicativo desktop é o **mesmo frontend** da versão web (React + TypeScript + Vite), empacotado com **Electron** para Windows 10/11 x64 e Linux x64 (Linux Mint e compatíveis). Não existe um segundo frontend: a diferença está só nas constantes de build (`VITE_AURORA_DESKTOP=1`) e nos adaptadores de integração.

## Decisão: Electron (e não Tauri)

| Critério | Electron | Tauri |
|---|---|---|
| Servidor local atual (IA, Meu Pluggy, HTML Network Bridge, pré-visualização de links) | Roda **no processo principal** sem reescrita: é Node (`node:https` com `lookup` de DNS dentro da conexão, `net.BlockList`, `fetch`) | Exigiria reescrever `server/` em Rust ou embarcar um Node “sidecar” (dois runtimes, outra superfície) |
| Motor de renderização | Chromium — o mesmo que a CI já testa (IndexedDB, iframe `sandbox`, CSP, canvas) | WebView2 no Windows (Chromium), **WebKitGTK no Linux** — outro motor, já visto com ~130 ms/quadro no canvas com `backdrop-filter` (memória do projeto) e diferenças de IndexedDB |
| Segurança | `contextIsolation`, sandbox, preload mínimo, protocolo próprio, controle de navegação/permissões/janelas | Bom modelo de permissões, mas a lógica de rede precisaria ser refeita e reauditada |
| Memória / tamanho | Maior (~100 MB instalado, ~150–250 MB em uso) | Menor |
| Distribuição | electron-builder: NSIS (Windows), AppImage e .deb (Linux), assinatura e atualização preparadas | Equivalente |
| Manutenção | Uma linguagem (TS) do frontend ao processo principal; reaproveita testes | Duas linguagens |

**Escolha: Electron.** O ganho de memória do Tauri não compensa reescrever e reauditar as integrações de rede (SSRF/DNS) nem trocar o motor no Linux. Não há implementação paralela.

## Processos

```
┌──────────────── processo principal (Node + Electron) ─────────────────┐
│ desktop/main.ts                                                         │
│  • ciclo de vida, janela única, menu mínimo                             │
│  • protocolo aurora://app → arquivos do frontend empacotado + cabeçalhos│
│    de segurança de hosting/headers.ts (CSP própria em /sandbox.html)     │
│  • políticas (desktop/security.ts): navegação, janelas, permissões      │
│  • D1-B: integrações (IA, rede dos widgets, Meu Pluggy, links) por IPC  │
│  • D1-C: credenciais no cofre do SO, arquivos com diálogo nativo         │
└───────────────▲───────────────────────────────────────────────────────┘
                │ IPC tipado (contextBridge → canais com validação)
┌───────────────┴──────── renderer (Chromium, sandbox) ─────────────────┐
│ desktop/preload.ts → window.auroraDesktop (objeto congelado, mínimo)   │
│ React, canvas, widgets, IndexedDB (perfil do app), estado              │
│   └─ iframe sandbox="allow-scripts" (/sandbox.html, origem opaca)       │
│      widgets HTML: sem preload, sem Node, sem acesso ao documento pai   │
└────────────────────────────────────────────────────────────────────────┘
```

## Carregamento seguro do frontend

- **Sem servidor HTTP.** O frontend é servido pelo esquema próprio `aurora://app`, registrado como `standard` + `secure`: origem estável (`aurora://app`) para o IndexedDB e o `localStorage`, e `'self'` funcionando na CSP.
- O protocolo só entrega arquivos de `renderer/` (dentro do `app.asar`): `..`, `.` e barras invertidas — inclusive codificados —, bytes nulos e outros hosts são recusados; arquivos do processo principal (`main.cjs`, `preload.cjs`) nunca são servidos.
- Cabeçalhos: os **mesmos** da hospedagem (`headersForPath` de `hosting/headers.ts`): CSP do app (`script-src 'self'`, `connect-src 'self'`, `frame-src 'self'`, `frame-ancestors 'none'`…), CSP própria do `/sandbox.html` (`default-src 'none'`), `nosniff`, COOP/CORP, `Referrer-Policy`. Só o HSTS é removido (não se aplica a esquema próprio). O build também embute a CSP como `<meta>`.

## Renderer isolado

`nodeIntegration: false`, `nodeIntegrationInSubFrames: false`, `contextIsolation: true`, `sandbox: true` (e `app.enableSandbox()` para todos), `webSecurity: true`, `allowRunningInsecureContent: false`, `webviewTag: false`, `navigateOnDragDrop: false`, DevTools desligadas no pacote (só com `AURORA_DESKTOP_DEVTOOLS=1`, usado pelos testes).

O preload expõe só `window.auroraDesktop` (congelado): em D1-A, `{ isDesktop, platform }`. Nenhum `require`, `process`, `ipcRenderer` ou objeto do Electron chega ao renderer.

## Navegação, janelas e permissões

- `will-navigate`, `will-frame-navigate`, `will-redirect`: só `aurora://app`.
- `window.open` / `target=_blank`: nunca abre janela no app; `http(s)` sem credenciais vai ao **navegador do sistema** (`shell.openExternal`); `file:`, `javascript:`, esquemas de SO e `aurora:` são ignorados.
- `<webview>` bloqueado.
- Permissões do Chromium: só `clipboard-sanitized-write` e `fullscreen`, e só para `aurora://app`. Câmera, microfone, localização, notificações, HID/USB/serial, leitura da área de transferência etc. são negados.
- Instância única: abrir de novo foca a janela existente (evita dois processos no mesmo perfil).

## Widgets HTML

Continuam no `iframe sandbox="allow-scripts"` sem `allow-same-origin`, carregando `aurora://app/sandbox.html` com a CSP sem rede. O preload não roda em subframes; o iframe (origem `null`) não alcança `window.auroraDesktop` do documento pai (`SecurityError`), nem `fetch` (CSP), nem WebRTC. HTML Data Bridge, HTML Network Bridge, tokens de montagem, autorizações por widget e proteção de dados sensíveis são o código da web, sem alteração. Testado no app Electron (`e2e-desktop/desktop.spec.ts`).

## Onde ficam os dados

O perfil do Chromium do app fica no diretório de dados do usuário, **fora da pasta de instalação**: `%APPDATA%\Aurora Board` (Windows) e `~/.config/Aurora Board` (Linux). IndexedDB (`aurora-board`, `aurora-finance`), `localStorage` (diário de recuperação) e configurações locais ficam lá. `AURORA_USER_DATA_DIR` troca a pasta (testes, uso portátil).

## Próximas etapas do D1

- **D1-B** — IPC tipado: IA, HTML Network Bridge, Meu Pluggy e pré-visualização de links no processo principal, sem servidor HTTP.
- **D1-C** — credenciais no cofre do SO, migração guiada navegador → desktop, recuperação.
- **D1-D** — instaladores (NSIS, AppImage, .deb), UX desktop, CI de empacotamento, documentação de usuário.
