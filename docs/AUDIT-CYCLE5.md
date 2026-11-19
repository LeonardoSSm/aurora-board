# Ciclo 5 — auditoria inicial (navegação espacial e câmera suave)

Base: `main` em `562d32e` (merge do ciclo 4). Branch: `feature/spatial-navigation-cycle-5`. Issue: LeonardoSSm/aurora-board#1.

## Baseline (antes das alterações)

| Comando | Resultado |
|---|---|
| `npm ci` | ok (servidor de desenvolvimento parado antes, para evitar o `EPERM` do ciclo 4) |
| `npm run typecheck` | ok |
| `npm test` | 16 arquivos, 301 testes passando |
| `npm run build` | ok |
| `npm run audit:prod` | 0 vulnerabilidades |
| `npm run test:e2e:all` | Chromium + WebKit + celular: 64 passando, 1 pulado (atalho de área de transferência no WebKit, preexistente). Firefox: `browserType.launch: spawn UNKNOWN` no Windows local (infraestrutura; roda no CI) |

## Diagnóstico

1. **Roda:** `Canvas.tsx` tratava `wheel` direto e chamava `zoomAt` (imediato). Roda simples: `exp(−Δ·0,001)` (≈ 10% por clique). **Ctrl + roda / pinça: `exp(−Δ·0,01)` — um clique de mouse de 100 px dava ≈ 63% de zoom**, a causa provável do “zoom agressivo”. Sem acumulação nem suavização.
2. **Touchpad × mouse:** heurística `trackpadLike` (deslocamento horizontal ou |Δ| < 40 fracionário) para pan × zoom no modo “Zoom” por quadro (`settings.wheelMode`). Mantida.
3. **Âncora:** `zoomAt` mantinha o ponto sob o cursor (fórmula correta), mas só como salto único.
4. **Hit-test:** `screenToWorld`/`worldToScreen` usam `state.camera`; o controlador converte cada evento com a câmera atual. Animar escrevendo `state.camera` a cada quadro mantém tudo coerente.
5. **Botões/atalhos/enquadrar:** `zoomStep` (níveis fixos), `zoomToBox`, `zoomToFit`, `zoomToSelection`, `focusElement` — todos imediatos.
6. **Pan e pinça:** controlador (`gesture.type = 'pan' | 'pinch'`) escreve a câmera direto.
7. **Persistência:** câmera em `board.camera`, gravada pelo autosave (assinatura em `state.camera`); configurações em `board.settings` (Zod com defaults, `migrateBoard` mescla com `DEFAULT_BOARD_SETTINGS`).
8. **Exportação:** `buildExport` serializa o quadro inteiro; `migrateBoard` reconstrói campo a campo (campos novos precisam ser incluídos explicitamente).
9. **Histórico:** entradas com `before/after` de elementos; `pushEntry` descarta entradas em que os elementos não mudaram (precisou considerar checkpoints).
10. **Overlays:** `Overlay.tsx` (SVG de seleção), menus em `ui/Overlays.tsx`; barra de ferramentas e dica no topo do canvas, controles de zoom no canto inferior esquerdo.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Animação escrever câmera em outro quadro | Cada animação guarda o `boardId`; `openBoard` cancela |
| Coordenadas imprecisas durante gestos | Qualquer `pointerDown` cancela a animação |
| Testes antigos lendo câmera durante animação | `reducedMotion: 'reduce'` por padrão no Playwright; câmera imediata |
| Checkpoints virarem conteúdo | Ficam em `board.checkpoints`, fora de `elements` |
| Backups antigos | Campos opcionais; saneamento item a item |
