# Desempenho

## Como medir

```bash
npm run perf
```

```bash
PERF_LABEL=depois PERF_ARROWS=near PERF_SIZES=1000,5000 npm run perf
```

- Roda o benchmark `e2e/perf/board.perf.ts` contra o **build de produção** (`vite build` + `vite preview`), em Chromium, com GC exposto.
- Para cada tamanho (100, 500, 1.000, 2.000, 5.000) gera um quadro **determinístico** (semente fixa): 60% formas (30% com texto, metade preenchidas, ¾ com traço à mão), 12% textos, 15% setas ancoradas, 3% widgets (notas/tarefas/finanças), 2% imagens, 10% das formas em grupos. Grava no IndexedDB.
- Operações por **eventos reais** no canvas (ponteiro, roda) → controlador → React → pintura: abrir, selecionar, arrastar, redimensionar, zoom, pan. Duas vistas: **fit** (tudo visível — pior caso, sem recorte) e **zoom 100%** (uso típico, com recorte do viewport).
- Métricas por passo: **work** (JS + React síncrono, medido na página) e **frame** (até o 2º `requestAnimationFrame`; piso ≈ 33 ms = 2 quadros a 60 Hz). Mais: custo de recalcular todas as setas, serialização do diário/autosave e heap após GC.
- `PERF_ARROWS=random` (padrão, pior caso: setas longas cruzando o quadro) ou `near` (realista: entre formas vizinhas). Resultados em `perf-results/<rótulo>.json` com hardware e navegador.

Ambiente das medições abaixo: Intel Core i5-1135G7 (8 threads), 16 GB, Windows 11, Chromium 159 (headless), viewport 1440×900, build de produção.

## Gargalos encontrados e corrigidos

| Gargalo | Evidência | Correção |
|---|---|---|
| `getDataflow` percorria **todos** os elementos a cada chamada; cada widget tem 2 seletores → O(elementos × widgets) por quadro | trabalho de arrasto crescia 8× de 2.000 para 5.000 elementos (só 2,5× mais elementos) | memoização pela referência do array imutável (`src/widgets/dataflow.ts`) |
| `getBoundingClientRect()` em todo evento de ponteiro/roda e no `pointermove` global forçava recálculo de estilo/layout de milhares de nós logo após cada mudança de câmera | trabalho de zoom alto mesmo sem mudança no React | retângulo do canvas em cache, atualizado por `ResizeObserver`/`resize` (`getCanvasRect`) |
| Setas renderizadas como SVG 1×1 com `overflow: visible` | — (não foi o gargalo, ver abaixo) | SVG com a caixa exata da linha; mantido por correção, sem ganho medido |

## Antes × depois (pior caso, setas aleatórias — mesma composição)

Trabalho de JS + React por passo (mediana, ms):

| Elementos | Vista | Arrasto | Zoom | Pan | Abrir quadro |
|---:|---|---|---|---|---|
| 1.000 | tudo visível | 5,4 → 4,9 | 4,7 → 4,3 | 4,3 → 5,0 | 44 → 39 |
| 2.000 | tudo visível | 8,6 → 6,3 | 7,7 → 5,5 | 7,3 → 5,6 | 46 → 38 |
| 5.000 | tudo visível (4.600 nós) | **68,5 → 9,0** | **151 → 78** | **73,6 → 8,6** | 57 → 43 |
| 5.000 | zoom 100% (~390 nós) | 6,4 → 8,6 | 7,1 → 7,9 | 5,7 → 6,1 | — |

Quadro total (até a pintura), mediana:

| Elementos | Vista | Arrasto | Zoom | Pan |
|---:|---|---|---|---|
| até 1.000 | qualquer | ~31 ms (2 quadros) | 31–57 ms | 31–50 ms |
| 5.000 | zoom 100% | ~30 ms | ~31 ms | ~30 ms (setas realistas) |
| 5.000 | tudo visível, setas realistas | ~80 ms | ~150 ms | ~82 ms |

Custos isolados com 5.000 elementos: recalcular todas as setas 1,2 ms; serializar o diário 4,3 ms (2,5 MB); clone para o IndexedDB 17 ms (por gravação, com debounce de 400 ms); heap ~21 MB.

## Limitações conhecidas (medidas, não resolvidas)

- **Muitos milhares de nós visíveis ao mesmo tempo** (enquadrar tudo num quadro de 5.000 elementos): o quadro fica limitado pela **pintura** do DOM/SVG (80–150 ms), não por JS. Experimento: escondendo as setas, o pan cai de 125 para 29 ms com setas longas; com setas realistas, de 46 para 29 ms. Não é resolvível com memoização; a alternativa é um nível de detalhe com renderização em `<canvas>` em zoom distante (ciclo futuro).
- **Diário de recuperação** usa `localStorage` (~5 MB): quadros acima de ~10.000 elementos não cabem; o IndexedDB continua gravando normalmente e o app avisa só se o IndexedDB falhar.
- As medições de quadro têm variação de ±15 ms entre execuções (pintura e agendamento do navegador); compare `work` para decisões finas.

## GIFs animados (ciclo 6)

`npx playwright test -c playwright.perf.config.ts e2e/perf/gifs.perf.ts` (build de produção, Chromium, i5-1135G7, movimento não reduzido; `perf-results/gifs-animados.json`). N GIFs de 96–208 px, todos visíveis e animando (quadros de 200 ms), 120 passos de pan + zoom:

| GIFs visíveis | Quadro médio | p95 | Heap JS |
|---|---|---|---|
| 0 | 16,7 ms | 16,7 ms | 10 MB |
| 25 | 16,8 ms | 16,8 ms | 10 MB |
| 100 | 16,7 ms | 16,7 ms | 12 MB |

A decodificação dos quadros é do navegador (fora do heap JS) e não pesou na navegação nessa escala; por isso não foi criada pausa automática fora da vista — o canvas já desmonta o que está fora da tela, e a retomada usa a mesma URL (sem reinício visível). GIFs grandes demais (largura × altura × quadros > 400 MP) ficam parados por proteção.
