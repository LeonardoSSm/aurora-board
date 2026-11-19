# Navegação espacial: checkpoints

Um quadro pode conter um universo inteiro (financeiro, arquitetura, ideias, viagens…). **Checkpoints** são pontos de referência nomeados em coordenadas do **mundo** desse quadro. Quadro = documento espacial independente; checkpoint = lugar dentro dele.

## Usar

- **Criar no ponto clicado:** botão direito num espaço vazio → **Adicionar checkpoint aqui** (usa a coordenada exata do clique).
- **Criar no centro da tela:** botão direito → **Salvar localização atual**, ou **Locais → Salvar aqui**.
- **Formulário:** nome (obrigatório, até 60), descrição (até 280), cor, ícone e “Restaurar o zoom ao navegar” (memoriza o zoom atual).
- **Locais** (botão de alfinete na barra superior ou tecla **G**): filtrar, ir, editar, subir/descer, excluir (com confirmação), mostrar/ocultar indicadores nas bordas.
- **Editar:** clique no marcador visível ou em “Editar” na lista. No formulário: Ir, Mover destino para a visão atual, Duplicar, Excluir.
- **Desfazer/refazer:** criar, editar, mover, reordenar, duplicar e excluir entram no histórico do quadro (Ctrl+Z / Ctrl+Y). Navegar não entra (mover a câmera nunca foi desfazível).

## Indicadores nas bordas

Para cada checkpoint fora da tela, calcula-se o vetor do **centro da área útil** até o ponto na tela e projeta-se esse vetor até a interseção com o **retângulo seguro** (`projectToRect`). O indicador fica nessa interseção, inteiro e visível, apontando na direção real — inclusive diagonais (um ponto acima à direita aparece perto do canto superior direito). A seta é girada pelo ângulo real.

- **Área útil:** o canvas menos a barra de ferramentas e a dica (topo, 86 px), os controles de zoom (base, 64 px), margens laterais e, no celular, os painéis abertos por cima.
- **Dentro da tela:** marcador discreto (ícone + nome) na posição real; o indicador de borda some.
- **Histerese de 12 px:** um checkpoint exatamente na borda não alterna entre os dois estados.
- **Agrupamento:** indicadores no mesmo lado a menos de 30 px (laterais) ou 120 px (topo/base) viram um chip **“N locais”**; clicar abre a lista com todos.
- **Acessibilidade:** cada indicador é um botão com nome acessível (“Ir para Financeiro (à esquerda)”), foco visível, tooltip com a descrição e 28 px de altura (34 px em telas de toque).
- **Custo:** depende só da câmera, do viewport e dos checkpoints — nunca percorre os elementos do quadro.

## Navegar

Clicar num indicador, num item do grupo ou da lista centraliza o checkpoint: `cameraX = W/2 − x·z`, `cameraY = H/2 − y·z`, com o **zoom atual** (ou o memorizado, se “restaurar zoom” estiver ligado). A viagem leva de 220 a 650 ms, conforme a distância, com um leve afastamento no meio em viagens longas, e termina exatamente no destino, com um destaque breve no marcador. Outro clique substitui o destino; pan, arrasto, pinça, troca de quadro e **Esc** interrompem. Com movimento reduzido, a câmera vai direto. Detalhes em [CAMERA_ENGINE.md](CAMERA_ENGINE.md).

## Persistência e compatibilidade

- `board.checkpoints` (metadados do quadro; **não** são elementos): `id`, `name`, `description`, `x`, `y`, `color`, `icon`, `savedZoom`, `restoreZoom`, `createdAt`, `updatedAt`. Configuração por quadro: `settings.showCheckpointIndicators` (ausente = ligado).
- Campos **opcionais** no esquema: quadros e backups antigos carregam sem mudança (lista vazia). `SCHEMA_VERSION` não mudou; não há migração destrutiva.
- Saneamento item a item ao abrir/importar: checkpoint inválido (nome vazio, coordenada não finita, fora de ±10⁹) é descartado com aviso **sem derrubar o quadro**; textos longos são cortados; cor/ícone desconhecidos viram padrão; zoom memorizado limitado a 0,1–8; ids repetidos são renomeados.
- Autosave, diário de recuperação e exportação JSON levam os checkpoints; importar como novo quadro e duplicar o quadro preservam tudo (a cópia é independente).
- Como não são elementos, checkpoints **não** entram em seleção, Ctrl+A, Enquadrar tudo, fluxo de dados, fórmulas, nem na exportação PNG/SVG.

## Desempenho

`npm run build && npx playwright test -c playwright.perf.config.ts e2e/perf/navigation.perf.ts` (resultados em `perf-results/navegacao-espacial.json`; build de produção, Chromium, i5-1135G7):

| Elementos | Checkpoints | Pan (mediana / p95) | Viagem entre extremos | Maior intervalo | Câmera final exata |
|---|---|---|---|---|---|
| 100 | 0 | 16,8 / 18,3 ms | 40 quadros | 16,8 ms | sim |
| 100 | 100 | 17,8 / 28,3 ms | 38 quadros | 33,4 ms | sim |
| 1.000 | 50 | 16,5 / 22,4 ms | 38 quadros | 33,3 ms | sim |
| 5.000 | 0 | 16,7 / 19,4 ms | 39 quadros | 16,8 ms | sim |
| 5.000 | 100 | 16,0 / 26,3 ms | 38 quadros | 33,4 ms | sim |

16,7 ms = 1 quadro a 60 Hz. Com 50–100 checkpoints aparece ocasionalmente um quadro perdido (33 ms). O zoom pela roda custa 1 quadro por evento; pan durante a animação não deixa quadros residuais (12/12).

## Limitações

- Indicadores de grupo mostram a lista ao clicar; não há prévia visual do destino.
- A área útil é estimada por margens fixas (barra superior, controles de zoom); menus temporários podem cobrir um indicador enquanto abertos.
- Checkpoints não aparecem em exportações de imagem (por desenho); não há opção para incluí-los.
