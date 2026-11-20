# Aurora Command Center (issue #14)

**Ctrl+K** (Windows/Linux) ou **Cmd+K** (Mac), ou o botão de busca na barra superior: uma paleta central para **encontrar, navegar, criar ou capturar** sem perder o contexto. Tudo é local: nenhuma consulta ou conteúdo sai do navegador, não há servidor, LLM nem custo.

## Paleta

- **Busca incremental** agrupada em **Quadros**, **Locais** (checkpoints), **Elementos**, **Tarefas** e **Ações**. Com o campo vazio: **Recentes** e as ações.
- **Teclado:** ↑/↓ navegam, **Enter** abre, **Esc** fecha e devolve o foco para onde estava; Ctrl+Home/End vão ao primeiro/último. Letras digitadas vão para a busca — os atalhos do quadro não disparam com a paleta aberta.
- **Acessibilidade:** campo `combobox` com `aria-activedescendant`, lista `listbox` com `option`s, cabeçalhos de grupo, filtros como `radiogroup`.
- **Filtros:** Tudo, Quadros, Locais, Notas e textos, Tarefas, Código, Outros; caixa **arquivados** (fora por padrão).
- **Ações** (nenhuma destrutiva): Novo quadro, Criar nota, Criar tarefa, Captura rápida, Abrir item capturado, Ir para local…, Ir para a seleção, Enquadrar tudo, Aurora Wheel, Abrir Minhas contas, Mostrar biblioteca, Quadros e workspaces, Ajuda e atalhos.

## O que é pesquisado

Busca **sem diferenciar maiúsculas nem acentos** (“orcamento” acha “Orçamento”), com **vários termos** (todos precisam aparecer). Ordem: título > início de palavra > corpo, com leve bônus de recência e para quadros/locais; o quadro atual desempata. Trechos curtos mostram o termo destacado (texto puro, sem HTML).

| Fonte | Indexado |
|---|---|
| Quadros | nome e descrição, em **todas** as workspaces |
| Locais (checkpoints) | nome e descrição |
| Textos, notas adesivas, formas, frames | texto e nome |
| Conexões (setas/linhas) | rótulo e relação |
| Notas (Markdown) | texto, sem URLs |
| Tarefas | cada item vira um resultado, com estado (a fazer/em andamento/concluída) e data |
| Código | linguagem e código |
| Documentos | **só metadados**: nome, descrição, etiquetas (nunca o arquivo nem a URL) |
| Calendário | títulos e datas dos eventos |
| Link | domínio e descrição |

### Privacidade (primeiro ciclo)

**Nunca** entram no índice: razão bancário, transações e cartões, valores de blocos financeiros (Valor, Mês, Fórmula, Gráfico, Finanças, Consulta bancária), **conversas, prompts e respostas de IA** (Assistente IA, AI Tile), **HTML/JS de sandbox**, tokens, credenciais e dados de API. Desses blocos — e de widgets de terceiros — indexa-se só o **título**, e o resultado avisa “conteúdo não pesquisável (privacidade)”. O índice vive **só em memória**: não há arquivo de índice, nada vai para backups, exportação ou logs. Os **recentes** guardam apenas chaves (`element:<quadro>:<id>`), nunca texto, e nada da consulta é gravado.

## Índice

- Construído no cliente ao abrir a paleta, lendo os quadros pelo `PersistenceAdapter` (IndexedDB).
- **Incremental:** cache por quadro com a `updatedAt` dos metadados — a cada abertura só relê o que mudou; quadros excluídos saem; nenhuma varredura contínua, nenhuma releitura a cada tecla.
- **Quadro ativo:** vem do estado em memória (inclui o que ainda não foi gravado) e é recalculado só quando elementos/locais mudam.
- Lotes de 4 quadros com pausa para a interface (indicador “indexando N/M”); uma nova indexação cancela a anterior.
- **Benchmark** (Vitest, MemoryAdapter, 100 quadros × 200 elementos = 20 mil): ver `tests/unit/command-center.test.ts` — indexação e busca dentro do orçamento (números na seção de testes do PR).

## Ir até o resultado

- **Quadro:** troca de workspace se preciso e abre o quadro.
- **Elemento/tarefa:** abre o quadro, **espera carregar**, seleciona e centraliza (`focusElement`, viagem suave da #12), com destaque breve. Coordenadas e histórico de desfazer não mudam.
- **Local:** abre o quadro e chama `navigateToCheckpoint` (animação da #12, zoom memorizado e movimento reduzido respeitados).
- **Corridas:** cada navegação recebe um token; se outra começar antes de a anterior terminar de abrir o quadro, a antiga não aplica foco. Item excluído desde a indexação → aviso, sem travar.

## Captura rápida / Inbox

**Ctrl+Shift+Espaço** (ou o botão na barra superior, ou a ação na paleta): Nota ou Tarefa, título, detalhes opcionais, destino. **Enter** no título (ou Ctrl+Enter nos detalhes) grava. A tela, a câmera e a **seleção não mudam**.

**Abordagem técnica**

- **Quadro atual:** `addElements(..., select = false)` — uma entrada de desfazer, sem mexer em seleção/câmera/ferramenta; o autosave grava normalmente.
- **Inbox em outro quadro:** escrita no adaptador **dentro da fila única do autosave** (`runExclusive`): lê a versão gravada mais recente, acrescenta só o elemento novo e grava. Nunca toca `getState().elements`. Recusa (mantendo o texto) se esse quadro tem gravação pendente ou com falha (`hasUnsavedWork`). `openBoard` também lê o quadro dentro dessa fila, então abrir o Inbox enquanto a captura grava sempre vê o item; se o quadro for aberto no meio, o item é injetado também no estado.
- **Reuso:** blocos **Notas** e **Tarefas** existentes, com o `sanitize` de cada widget — nenhuma base paralela de tarefas. Nada de IA ou finanças é copiado.
- **Sem migração:** quadros e backups não ganham campos. O Inbox escolhido é configuração local por workspace (`inboxBoard:<workspace>`).
- **Falhas:** destino inexistente, cota esgotada ou erro do IndexedDB → mensagem no formulário, texto preservado, quadro intacto.

## Atalhos

| Atalho | Ação |
|---|---|
| Ctrl+K / Cmd+K | Command Center |
| Ctrl+Shift+Espaço | Captura rápida (Ctrl+Espaço é usado por IMEs; com Shift não conflita nos navegadores testados) |

## Fora deste ciclo

Busca em nuvem, embeddings/LLM, OCR/PDF, sincronização externa, favoritos/pins na paleta e busca por conteúdo financeiro (só numa superfície específica e autorizada, no futuro).
