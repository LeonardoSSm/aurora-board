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
| **Viagem** | botões +/−, Ctrl+= / Ctrl+− / Ctrl+0, Enquadrar tudo, Zoom na seleção, Abrir assistente, checkpoints | Interpola o **centro** do mundo e o zoom em escala logarítmica, com `easeInOutCubic` (sem ultrapassar o destino). Duração de 220 a 650 ms, crescendo com o logaritmo da distância; em distâncias longas (mais de 2 telas), afasta um pouco no meio do caminho (`arc`, até 45%). Em t = 1 a câmera é **exatamente** o destino. |
| **Imediato** | pinça do touchpad e de toque, pan (arrastar, Espaço, botão do meio, touchpad), `zoomAt` | Escrito direto; cancela qualquer animação. |

Um único laço de `requestAnimationFrame` por vez. Pedidos novos **substituem** o destino (zoom: acumulam no alvo atual; viagem: partem da câmera atual). Não há fila de animações atrasadas: parar a roda para o zoom em ~200 ms, e inverter o sentido muda o alvo na hora, sem salto.

## Cancelamento

- Qualquer novo gesto no canvas (`pointerDown` do controlador): pan, arrasto de elemento, desenho, seleção, pinça.
- Pan durante um **zoom** contínuo: a âncora é deslocada junto (continua suave, sem salto); durante uma **viagem**: cancela.
- Trocar de quadro (`openBoard`); e cada animação guarda o quadro em que começou e para sozinha se o quadro mudar — nunca escreve câmera em outro quadro.
- Mudança de tamanho do viewport; `Esc`; desmontagem.
- Cancelar congela a câmera onde está (sem quadros residuais).

## Movimento reduzido

Com `prefers-reduced-motion: reduce` (ou fora de um navegador), todo movimento é imediato: mesmo destino, sem animação. Os testes E2E antigos rodam assim por padrão (`reducedMotion: 'reduce'` no `playwright.config.ts`); os de câmera ativam o movimento com `test.use({ reducedMotion: 'no-preference' })`.

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

`zoomTowardAnchor(fator, âncora)`, `panCamera(dx, dy)`, `animateCameraTo(câmera, { onDone })`, `panToWorldPoint(ponto, { zoom })`, `fitCameraToBounds(caixa)`, `zoomToLevel(zoom)`, `cameraTarget()`, `cancelCameraAnimation()`, `isCameraAnimating()`. As ações antigas (`zoomStep`, `resetZoom`, `zoomToFit`, `zoomToSelection`, `focusElement`, `panBy`) delegam a elas; `zoomAt` continua imediato.
