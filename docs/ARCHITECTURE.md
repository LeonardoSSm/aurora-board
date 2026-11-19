# Arquitetura

O Aurora Board é um editor de quadro branco com **motor de canvas próprio** (React + TypeScript): formas em SVG e widgets em HTML convivem num único “mundo” transformado (translate + scale), com o mesmo modelo de dados, ordem de camadas e conexões.

## Camadas

```
core/          regras puras, sem React (testadas isoladamente)
  schema.ts       esquemas zod → tipos (elementos, quadros, workspaces, assets); SCHEMA_VERSION
  elements.ts     fábricas, estilos padrão, clonagem com remapeamento
  geometry.ts     limites, rotação, hit-test, ancoragem, curvas (Catmull-Rom), cotovelo
  bindings.ts     setas ancoradas acompanhando elementos
  groups.ts       grupos aninhados, camadas, frames
  transform.ts    redimensionar/rotacionar
  snapping.ts     encaixe em objetos (guias)
  history.ts      desfazer/refazer por snapshots imutáveis
  text.ts         medição, quebra, ajuste de formas ao texto
  finance.ts      regras financeiras (centavos, parcelas, períodos, entradas)
  dataflow.ts     fluxo de dados tipado + ciclos (Tarjan)
  connectionStyle.ts  aparência por tipo de conexão
  camera.ts       conversões tela↔mundo, zoom ancorado, interpolação, roda e sensibilidade
  checkpoints.ts  modelo e saneamento dos checkpoints espaciais
  edgeIndicators.ts  projeção dos indicadores na borda, histerese, agrupamento
canvas/        controlador de ponteiro (máquina de estados), alças, overlay, editor de texto, render de elementos
render/        geração de SVG (tela e exportação), PNG/SVG
store/         Zustand: estado, comandos com histórico, inicialização, demonstração
persistence/   PersistenceAdapter, IndexedDB, memória, autosave por revisões + diário, migrações, import/export, legado v0.3
widgets/       contrato/registro, moldura, fluxo de dados, nativos, terceiros (sandbox)
integrations/  cliente de IA (só /api) e contexto autorizado
ui/            topo, ferramentas, biblioteca, propriedades, quadros, menus, diálogos, atalhos, dicas
server/        app.ts (HTTP, proteções), netSafety.ts (SSRF), providers.ts (IA)
```

Dependências apontam para baixo: `ui/canvas/widgets → store → persistence/core`. `core/` não importa nada do app.

## Decisões

| Decisão | Motivo |
|---|---|
| Motor próprio em vez de tldraw/Excalidraw/React Flow/Konva | licença (tldraw), widgets HTML interativos e fluxo de dados nativos (Excalidraw só tem iframes), desenho livre (React Flow), HTML sobre canvas (Konva) |
| Elementos imutáveis + histórico por snapshots de referências | desfazer barato (O(n) ponteiros), memoização por referência em todo o app |
| Hit-test geométrico no controlador (não por alvo DOM) | precisão independente do zoom; widgets são a exceção (controles internos recebem eventos nativos) |
| Persistência atrás de `PersistenceAdapter` | testes com adaptador em memória/controlado; sincronização futura com backend sem tocar no editor |
| Autosave com revisões por quadro + diário síncrono por quadro | nenhuma gravação antiga confirma revisão nova; recuperação após fechar a aba (docs/PERSISTENCE.md) |
| Câmera animada gravada no estado a cada quadro (`store/cameraMotion.ts`), nunca transição CSS | o que se vê é exatamente o que o hit-test usa; um só laço rAF, destino substituível |
| Checkpoints nos metadados do quadro, não em `elements` | não entram em seleção, Enquadrar tudo, fluxo de dados nem exportação de imagem; desfazer pelo mesmo histórico |
| Servidor local mínimo (Node `http`) | só proxy de IA e pré-visualização; chaves fora do frontend; proteções em docs/SECURITY.md |
| Plugins de terceiros em iframe sandbox + CSP | isolamento real sem confiar no código do plugin |

## Fluxos principais

- **Interação**: `Canvas` converte eventos em `PointerInfo` (tela + mundo) → `controller.ts` decide o gesto (pan, seleção por área, mover, redimensionar, rotacionar, criar, editar pontos de seta, borracha, pinça) → durante o gesto usa `setTransient` (sem histórico) → `endGesture` grava uma entrada de histórico.
- **Comandos discretos** (`store/actions.ts`): `commit(mutator)` aplica, propaga setas ancoradas (`settle`) e grava no histórico; o autosave observa o estado.
- **Render**: `Canvas` recorta pelo viewport, `ElementView` é memoizado por elemento; `Overlay` desenha alças/guias em coordenadas de tela (tamanho constante).
- **Widgets**: `WidgetFrame` dá moldura, estado de erro isolado e API do host; cada plugin declara portas tipadas e `compute`; `dataflow.ts` calcula entradas/saídas a partir das conexões do tipo “dados”.

## Pontos de extensão

Ver README (“Arquitetura → Pontos de extensão”): novo adaptador de persistência, provedor de IA, widget nativo, plugin de terceiros.

## Ganchos de depuração

`window.__aurora` expõe `getState`, `store`, `actions`, `elements` e `core` (mesma instância de módulo do app). Usado pelos testes E2E e pelo benchmark; útil no console para reproduzir bugs.
