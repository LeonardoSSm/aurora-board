# Aurora Board

Workspace visual infinito, modular e extensível. **O quadro branco é o sistema**: formas, textos, desenhos e componentes funcionais (finanças, tarefas, IA…) convivem livremente no mesmo canvas, sem layout obrigatório.

> Protótipo de referência preservado em [`reference/Aurora_Board_v0.3.html`](reference/Aurora_Board_v0.3.html). Dados dele podem ser importados (ver “Compatibilidade”).

---

## Como executar

Requisitos: Node.js 20+ (testado com Node 24).

```bash
npm install
```

```bash
npm run dev
```

Abra http://localhost:5173. O comando inicia **dois processos**: o frontend (Vite, porta 5173) e o servidor local de integrações (porta 8787, só em `127.0.0.1`), acessado pelo frontend via proxy `/api`.

Na primeira execução são criados o workspace “Meu workspace”, um quadro vazio (“Meu primeiro quadro”) e um quadro “Demonstração” com exemplos (pode ser excluído). Se houver dados do protótipo v0.3 no mesmo navegador (`localStorage`), eles são importados automaticamente **sem apagar o original**.

### Ativar a IA (opcional)

```bash
cp .env.example .env
```

Preencha **apenas** as chaves que possuir (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`; modelos opcionais em `*_MODEL`) e reinicie `npm run dev`. As chaves ficam somente no servidor local; o frontend nunca as recebe. Sem chave, o bloco de IA mostra **“Não configurado”** e não gera respostas simuladas.

### Scripts

| Comando | O que faz |
|---|---|
| `npm run dev` | Frontend + servidor local (recarga automática) |
| `npm run dev:web` | Só o frontend (IA e pré-visualização de links ficam indisponíveis) |
| `npm test` | Testes unitários (Vitest) |
| `npm run test:e2e` | Testes de interação no navegador (Playwright; sobe o servidor se preciso). Na primeira vez: `npx playwright install chromium` |
| `npm run typecheck` | Verificação de tipos |
| `npm run build` | Build de produção em `dist/` |

---

## Status das funcionalidades

Legenda: ✅ implementado e testado · 🟡 implementado, depende de configuração externa · 🔜 previsto na arquitetura, não implementado.

### Editor visual
- ✅ Canvas infinito: zoom pela roda (configurável para “navegar”), pinça do touchpad, Ctrl+roda, botões, zoom focado no cursor, enquadrar tudo, zoom na seleção, pan com mão / Espaço / botão do meio / dois dedos.
- ✅ Ferramentas: seleção, mão, retângulo, losango, elipse, seta, linha, desenho livre (pressão de caneta), texto, nota adesiva, borracha, frame, imagem, conectar.
- ✅ Selecionar (clique, Shift+clique, área), arrastar, redimensionar (8 alças, Shift = proporção, Alt = do centro), rotacionar (Shift = 15°), duplicar (Ctrl+D, Alt+arrastar), copiar/recortar/colar (também imagens e texto da área de transferência; URL colada vira bloco de Link), excluir, bloquear, camadas, agrupar/desagrupar (grupos aninhados; duplo clique entra no grupo), alinhar, mover com setas do teclado, desfazer/refazer (histórico por quadro).
- ✅ Texto: duplo clique em forma escreve dentro dela (o texto acompanha mover/redimensionar/rotacionar e a forma cresce para caber); texto independente; S/M/L/XL + tamanho livre; fontes Manual (Kalam), Sans (Inter), Mono (JetBrains Mono), Serifada (Lora); alinhamento horizontal e vertical; cor; opacidade.
- ✅ Fluxograma como no Excalidraw: **Ctrl+setas** cria um nó conectado (seta em cotovelo), **Alt+setas** navega entre nós conectados.
- ✅ Encaixe em objetos com guias ao mover (bordas e centros); **Ctrl** durante o arrasto liga/desliga; opção por quadro.
- ✅ Dica contextual sob a barra de ferramentas; copiar/colar estilo (**Ctrl+Alt+C / Ctrl+Alt+V**).
- ✅ Painel de propriedades contextual com ícones (multisseleção com valores “mistos”), estilos limpo/“à mão” (roughjs), preenchimento sólido/hachura/cruzado, traço sólido/tracejado/pontilhado, bordas retas/arredondadas.
- ✅ Setas e linhas com vários pontos, como no Excalidraw: **clique** (sem segurar) para iniciar, cada clique adiciona um ponto, com prévia até o cursor; termina com **clique no último ponto, Enter ou Esc**, ou clicando sobre uma forma (ancora e finaliza). Arrastar continua criando a seta simples. Tipo **curva** (padrão das setas) passa suavemente pelos pontos; **reta** forma cantos; **cotovelo** é roteado.
- ✅ Edição de pontos: com a seta selecionada, arraste qualquer ponto; arraste o ◦ entre dois pontos para criar um novo; clique num ponto e **Delete** remove.
- ✅ Conexões: setas ancoradas acompanham os elementos (pontos internos ficam no lugar); pontos de conexão fixos (topo/direita/base/esquerda) ou ancoragem automática; traçado reto/curvo/cotovelo; pontas configuráveis; rótulos; menu de contexto.

### Blocos (widgets)
| Bloco | Status | Observação |
|---|---|---|
| Notas | ✅ | Markdown com pré-visualização sanitizada (DOMPurify) |
| Tarefas | ✅ | Estados, prioridades, prazos, recebe tarefas por conexão de dados |
| Finanças | ✅ | Receitas/despesas, categorias, vencimentos, parcelas, período, 3 moedas, 3 formatos, saldo previsto e realizado, entradas por conexão |
| Calendário | ✅ local · 🔜 Google | Mês, eventos com horário. Google Calendar exige OAuth (não implementado) |
| Documentos | ✅ | Arquivos guardados no IndexedDB (até 25 MB cada) ou referências por URL; prévia de imagem, PDF e texto |
| Imagem | ✅ | Inserir por botão, colar ou arrastar arquivo |
| Link | ✅ · 🟡 prévia | Prévia Open Graph via servidor local (bloqueia endereços de rede local) |
| Código | ✅ | Destaque de sintaxe (10 linguagens), Tab, copiar |
| Assistente IA | 🟡 | OpenAI, Claude e Gemini via servidor local; só envia contexto conectado e autorizado; respostas estruturadas viram blocos/tarefas/conexões **somente após confirmação** |
| Gráfico | ✅ | Barras/rosca a partir de blocos financeiros conectados |
| HTML isolado | ✅ experimental | Base de plugins de terceiros (iframe sandbox + CSP) |
| Google Calendar, Google Drive, GitHub, API externa, Indicadores, Dashboard, Ferramentas de dev | 🔜 | Listados na biblioteca como “Futuro”, com o requisito de ativação |

### Dados
- ✅ Workspaces → quadros → elementos; criar, renomear, descrever, duplicar, reordenar, pesquisar, arquivar, excluir (com confirmação).
- ✅ Salvamento automático no IndexedDB (debounce 400 ms) + **diário de recuperação** síncrono no `localStorage`: se o navegador fechar antes do IndexedDB confirmar, as alterações são restauradas na próxima abertura.
- ✅ Exportar JSON (quadro ou workspace inteiro, com imagens/arquivos), PNG e SVG (quadro, seleção, com/sem fundo, fontes embutidas).
- ✅ Importar JSON: sempre **como novos quadros**, com relatório e avisos antes de confirmar; nunca sobrescreve.
- ✅ Esquema versionado (`SCHEMA_VERSION = 3`) com pipeline de migrações e validação por elemento (um elemento inválido não derruba o quadro).

---

## Compatibilidade com v0.2 / v0.3

Importação por **Importar → Arquivo JSON** (backup exportado do protótipo) ou **Importar → Dados do protótipo v0.3 deste navegador** (`localStorage['aurora-board-v2-data']`).

| v0.3 | Aurora Board 1.0 |
|---|---|
| Anotação / Estrutura | Bloco Notas (Markdown) |
| Checklist | Tarefas (`done` → estado “feito”) |
| Finanças (`value` ±) | Finanças em centavos (`+` receita, `−` despesa, marcado como pago) |
| Agenda | Calendário |
| ChatGPT (prompt) | Assistente IA (instrução permanente) |
| Link, Imagem | Link, Imagem (imagem embutida vira arquivo local) |
| Formas manuais e texto | Formas/texto com estilo, fonte, tamanho e alinhamento preservados (traço limpo) |
| Conexões referência / contexto / fluxo | Setas ancoradas: visual / contexto / visual “fluxo / dependência” (**fluxo não vira execução**) |
| Grupos, traços de caneta, câmera | Grupos, desenho livre, câmera |

Tipos desconhecidos, campos não reconhecidos e conexões para blocos inexistentes aparecem no relatório de importação.

---

## Conexões funcionais

Cada seta tem um **tipo** (ferramenta Conectar `C` → escolha o tipo, ou altere no painel):

| Tipo | Efeito |
|---|---|
| Visual | Nenhum. Documentação/relacionamento (com rótulo e relação livre). |
| Contexto | O destino pode **ler** o conteúdo da origem (ex.: IA), e cada fonte pode ser desmarcada. Nada é enviado sem o usuário acionar. |
| Dados | Valores tipados fluem entre widgets compatíveis (ex.: `finance.summary` → entrada “Saldo recebido”). Tipos incompatíveis e ciclos são detectados e desativados com aviso. Cálculo puro, sem efeitos externos. |
| Execução | Habilita ações da origem sobre o destino (ex.: IA → Tarefas), **sempre com confirmação**. |

Exemplo da demonstração: **Salário → (dados) → Despesas do mês → (dados) → Gráfico**. O saldo de “Despesas do mês” inclui o salário recebido; o gráfico mostra gastos por categoria.

Regras financeiras (testadas em `tests/unit/finance.test.ts`): valores em centavos inteiros; parcelas “dividir total” distribuem centavos restantes nas primeiras; vencimentos mensais com ajuste de fim de mês; período filtra parcelas por mês; moedas diferentes nunca são somadas.

---

## Arquitetura

**Decisão principal:** motor de canvas próprio em React + TypeScript, renderizando formas em SVG e widgets em HTML dentro de um único “mundo” transformado (translate + scale). Bibliotecas avaliadas:

- **tldraw** — excelente, mas o SDK atual exige licença comercial/marca d’água; acoplaria o modelo de dados ao dele.
- **Excalidraw** (MIT) — ótima experiência de desenho, porém widgets interativos só como iframes “embeddable”, sem fluxo de dados nativo entre elementos.
- **React Flow** — grafo de nós; inadequado para desenho livre.
- **Konva** — canvas 2D puro; exigiria sobrepor HTML para widgets e reimplementar texto editável.

Composição escolhida: **roughjs** (traço à mão, MIT) + **perfect-freehand** (desenho livre, MIT) + **Zustand** (estado) + **idb** (IndexedDB) + **zod** (esquemas) + **Tailwind v4**. Formas e widgets compartilham o mesmo modelo, a mesma ordem de camadas e as mesmas conexões.

```
src/
  core/            Modelo e regras puras (sem React) — testadas isoladamente
    schema.ts        Esquemas zod: elementos, quadros, workspaces, assets (tipos derivados)
    elements.ts      Fábricas, estilos padrão, clonagem com remapeamento de vínculos
    geometry.ts      Limites, rotação, hit-test, ancoragem
    bindings.ts      Setas ancoradas acompanhando elementos
    groups.ts        Grupos aninhados, camadas, frames
    transform.ts     Redimensionar/rotacionar (único e múltiplo)
    history.ts       Desfazer/refazer por snapshots imutáveis (sem cópia profunda)
    text.ts          Medição/quebra de texto
    finance.ts       Regras e cálculos financeiros
    dataflow.ts      Fluxo de dados tipado + detecção de ciclos (Tarjan)
  canvas/          Motor de interação: controller (máquina de estados de ponteiro), alças, overlay, editor de texto
  render/          Geração de SVG (tela e exportação), exportação PNG/SVG
  store/           Zustand: estado, comandos com histórico, inicialização, demonstração
  persistence/     Interface PersistenceAdapter, IndexedDB, memória, autosave+diário, migrações, import/export, legado v0.3
  widgets/         Registro/contrato de plugins, moldura, fluxo de dados, plugins nativos, plugins de terceiros (sandbox)
  integrations/    Cliente de IA (fala só com /api) e construção de contexto autorizado
  ui/              Topo, ferramentas, biblioteca, propriedades, quadros, menus, diálogos, atalhos
server/            Servidor local (Node http): proxy de IA (OpenAI/Anthropic/Gemini) e pré-visualização de links
tests/unit/        Vitest (núcleo, finanças, persistência, legado, fluxo, IA, store, provedores, plugins)
e2e/               Playwright (critérios de aceitação com mouse/teclado reais)
```

Pontos de extensão:
- **Persistência substituível**: implemente `PersistenceAdapter` (`src/persistence/adapter.ts`) para sincronizar com um backend (ex.: NestJS + Prisma + PostgreSQL), mantendo IndexedDB como cache offline.
- **Novo provedor de IA**: implemente `Provider` em `server/providers.ts`.
- **Novo widget nativo**: implemente `WidgetPlugin` (`src/widgets/registry.ts`) — id estável, versão, ícone, permissões, portas de entrada/saída tipadas, `createData`, `sanitize` (migração/validação), `compute` (saídas), `summarize` (contexto de IA/exportação), `Component` — e registre em `src/widgets/builtin/index.ts`.
- **Plugin de terceiros**: `registerSandboxedPlugin(manifesto)` (`src/widgets/thirdParty.tsx`) valida o manifesto (zod) e executa o HTML em iframe `sandbox="allow-scripts"` (sem `allow-same-origin`) com CSP sem rede; comunicação só por `postMessage` (`aurora.setState(...)`). O quadro guarda apenas o estado, nunca o código.

---

## Atalhos

`V`/`1` seleção · `H` mão · `R`/`2` retângulo · `D`/`3` losango · `O`/`4` elipse · `A`/`5` seta · `L`/`6` linha · `P`/`7` desenho · `T`/`8` texto · `I`/`9` imagem · `E`/`0` borracha · `N` nota adesiva · `F` frame · `C` conectar · `Q` manter ferramenta

`Ctrl+setas` fluxograma · `Alt+setas` navegar · `Ctrl+Alt+C/V` estilo · `Ctrl+A/C/X/V/D` · `Ctrl+G` / `Ctrl+Shift+G` · `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` · `Ctrl+Shift+L` bloquear · `Ctrl+]`/`[` camadas · `Delete` · `Esc` · `Enter` editar texto · setas movem · `Shift+1` enquadrar · `Shift+2` zoom na seleção · `Ctrl+0/+/−` zoom · `?` ajuda. Atalhos de letra são ignorados enquanto se digita em campos.

---

## Testes e verificação

- `npm test` — 95 testes unitários (geometria, transformações, encaixe, roteamento em cotovelo, fluxograma, setas multiponto, conexões, grupos, histórico, finanças, fluxo de dados, contexto de IA, contrato dos provedores com `fetch` simulado, persistência IndexedDB, migrações, importação v0.3, plugins, comandos do editor).
- `npm run test:e2e` — 12 cenários no Chromium cobrindo os critérios de aceitação 1–16, 19 e 20 com mouse e teclado reais, mais um cenário de paridade com o Excalidraw (Enter, Ctrl+setas, foco, dicas).

Critério 18 (IA com credenciais válidas): o contrato de requisição/resposta de cada provedor é testado com `fetch` simulado; **uma chamada real não foi verificada** porque não havia chave disponível no ambiente de desenvolvimento.

Medição de desempenho (painel do navegador embutido, 2.000 formas visíveis): ~11 ms por atualização durante arrasto e ~8,5 ms por passo de pan (JS + React, sem tempo de pintura).

## Limitações conhecidas / próximos passos

- Integrações Google (Calendar/Drive), GitHub e demais “Futuro” não implementadas (exigem OAuth/infra).
- Sincronização com backend e colaboração em tempo real: arquitetura preparada (`PersistenceAdapter`), não implementada.
- Recorte visual de frames e desvio automático de obstáculos em setas de cotovelo ainda não existem.
- Importação de arquivos `.excalidraw` não suportada.
- Bundle de ~730 KB (230 KB gzip): candidatos a carregamento sob demanda são highlight.js e o bloco de IA.
- O servidor local não tem autenticação: é para uso local (`127.0.0.1`). Para multiusuário, substituir por backend com autenticação.
