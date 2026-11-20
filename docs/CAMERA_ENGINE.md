# Motor de câmera

Arquivos: `src/core/camera.ts` (matemática pura) e `src/store/cameraMotion.ts` (animação). Toda movimentação da câmera passa por eles. A câmera animada é gravada no estado a cada quadro, e é a **mesma** usada para desenhar e para o hit-test: não há transição CSS separada.

## Coordenadas

```
tela  = mundo × zoom + (x, y)
mundo = (tela − (x, y)) ÷ zoom
```

`(x, y)` é a translação da câmera em pixels do canvas; `zoom` vai de 0,1 a 8. `centerOn(w, z, vp)` dá `x = W/2 − wx·z`, `y = H/2 − wy·z`.

## Tipos de movimento

| Movimento | Usado por | Como funciona |
|---|---|---|
| **Zoom contínuo** | roda do mouse, Ctrl + clique de roda | O alvo de zoom acumula os eventos; a câmera se aproxima dele por uma curva exponencial **dependente do tempo** (`approachZoom`, τ = 70 ms), não da taxa de quadros. A âncora (ponto do mundo sob o cursor) fica parada **em todos os quadros**: `x = âncora − mundo·zoom`. |
| **Viagem** | Enquadrar tudo, Zoom na seleção, Abrir assistente, checkpoints, focar elemento | **Trajeto de voo** (`flightPath`, van Wijk & Nuij 2003): o centro anda em linha reta até o destino enquanto a câmera se afasta e volta, de modo que a velocidade na tela fica constante; `easeInOutCubic` por cima dá aceleração e desaceleração. Duração conforme a velocidade escolhida (tabela abaixo). Em t = 1 a câmera é **exatamente** o destino. |
| **Zoom por botão** | botões +/−, Ctrl+= / Ctrl+− / Ctrl+0 | Interpolação direta (centro linear, zoom logarítmico) de 180 ms. |
| **Imediato** | pinça do touchpad e de toque, pan (arrastar, Espaço, botão do meio, touchpad), `zoomAt` | Escrito direto; cancela qualquer animação. |

Um único laço de `requestAnimationFrame` por vez. Pedidos novos **substituem** o destino (zoom: acumulam no alvo atual; viagem: partem da câmera atual). Não há fila de animações atrasadas: parar a roda para o zoom em ~200 ms, e inverter o sentido muda o alvo na hora, sem salto.

## Viagem

`travelPlan(de, para, viewport, velocidade)` devolve o trajeto e a duração = mínimo + ganho × comprimento do trajeto, limitada ao máximo. `FLIGHT_RHO = 0,7` (o d3 usa √2): afastamento discreto em viagens curtas, maior só nas longas. O parâmetro `r(b)` usa a forma estável `−asinh(b)` (antes `ln(√(b²+1) − b)`, que cancelava com o centro quase parado e grande mudança de zoom → comprimento infinito, quadros NaN e “teleporte”; apontamento do PR #16, coberto em `navigation-motion.test.ts`).

| Distância (larguras de tela) | Afastamento máximo | Rápida | **Suave (padrão)** | Cinematográfica |
|---|---|---|---|---|
| 0,25 | 0,2% | 196 ms | 310 ms | 472 ms |
| 1 | 3% | 242 ms | 398 ms | 628 ms |
| 3 | zoom × 0,81 | 355 ms | 611 ms | 1004 ms |
| 12 | zoom × 0,32 | 643 ms | 1154 ms | 1962 ms |
| 50+ | até o zoom mínimo (0,1) | 700 ms | 1200 ms | 2000 ms |
| só zoom 2× | — | 269 ms | 448 ms | 717 ms |

Antes (até a issue #12): 220–650 ms para qualquer distância, com afastamento de no máximo 45%. Limites por perfil (mínimo/máximo): Rápida 180/700 ms, Suave 280/1200 ms, Cinematográfica 420/2000 ms. A preferência é lida a cada viagem.

**Ativação** (`motionEnabled`): sem `requestAnimationFrame` → imediato. Preferência `navigationPrefs.motion`: “Nunca” → imediato; “Sempre” → anima; “Sistema” → anima salvo `prefers-reduced-motion: reduce`. Vale para todo o motor (viagens e zoom suave da roda).

**Medido no E2E** (`e2e/smooth-navigation.spec.ts`, 1440×900, ~12 telas): Chromium ~70 quadros em ~1,15 s, nenhum quadro com mais de 30% do trajeto, aproximação monotônica e câmera final exata. WebKit no Windows desenha menos quadros (ver limitações em SPATIAL_NAVIGATION.md), com o mesmo destino exato.

## Cancelamento

- Qualquer novo gesto no canvas (`pointerDown` do controlador): pan, arrasto de elemento, desenho, seleção, pinça.
- Pan durante um **zoom** contínuo: a âncora é deslocada junto (continua suave, sem salto); durante uma **viagem**: cancela.
- Trocar de quadro (`openBoard`); e cada animação guarda o quadro em que começou e para sozinha se o quadro mudar — nunca escreve câmera em outro quadro.
- Mudança de tamanho do viewport; `Esc`; desmontagem.
- Cancelar congela a câmera onde está (sem quadros residuais).

## Movimento reduzido

Com `prefers-reduced-motion: reduce` e a preferência no padrão “Sistema” (ou fora de um navegador), todo movimento é imediato: mesmo destino, sem animação. “Sempre” anima mesmo assim; “Nunca” nunca anima. Os testes E2E antigos rodam assim por padrão (`reducedMotion: 'reduce'` no `playwright.config.ts`); os de câmera ativam o movimento com `test.use({ reducedMotion: 'no-preference' })`.

## Roda, touchpad e sensibilidade

- `normalizeWheel`: `deltaMode` 1 (linhas) × 16 px, 2 (páginas) × altura da página; valores não finitos viram 0.
- Cada evento é limitado a ±150 px (eventos anormais não viram saltos).
- Fator de zoom = `exp(−Δ · ganho · sensibilidade)`. Ganho de roda: 0,0015/px (um clique de 100 px ≈ 16% em “Normal”). Pinça do touchpad (Ctrl + eventos pequenos e fracionários): ganho próprio, 0,009/px, aplicado direto para seguir os dedos.
- Antes: Ctrl + clique de roda dava `exp(−1)` ≈ **63%** por clique. Agora usa o mesmo ganho de clique da roda (≈ 13% no padrão).
- O modo da roda por quadro (Zoom / Navegar) e a regra de touchpad (rolagem com dois dedos faz pan) foram mantidos.

| Sensibilidade | Multiplicador | Um clique de roda |
|---|---|---|
| Preciso | 0,55 | ≈ 9% |
| **Suave (padrão)** | 0,8 | ≈ 13% |
| Normal | 1 | ≈ 16% |
| Rápido | 1,6 | ≈ 27% |
| Personalizado | 0,25 a 2,5 | ≈ 4% a 45% |

**Decisão:** a sensibilidade é preferência **geral** do usuário (configuração local `zoomPreferences` no IndexedDB, não no quadro); o modo da roda continua **por quadro**. Valores ausentes ou inválidos viram o padrão.

## API

`flightPath(de, para, vp)`, `travelPlan(de, para, vp, velocidade)`, `sanitizeNavigationPrefs`, `zoomTowardAnchor(fator, âncora)`, `panCamera(dx, dy)`, `animateCameraTo(câmera, { onDone, duration })`, `panToWorldPoint(ponto, { zoom })`, `fitCameraToBounds(caixa)`, `zoomToLevel(zoom)`, `cameraTarget()`, `cancelCameraAnimation()`, `isCameraAnimating()`. As ações antigas (`zoomStep`, `resetZoom`, `zoomToFit`, `zoomToSelection`, `focusElement`, `panBy`) delegam a elas; `zoomAt` continua imediato.
