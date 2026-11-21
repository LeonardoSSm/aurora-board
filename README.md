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
| `npm run verify` | **Antes de cada commit**: tipos + unitários + build + E2E (Chromium) |
| `npm test` | Testes unitários (Vitest) |
| `npm run test:e2e` | Testes de interação no Chromium (sobe o servidor se preciso). Na primeira vez: `npx playwright install chromium` |
| `npm run test:e2e:all` | Chromium, Firefox, WebKit e celular (Pixel 7, toque) |
| `npm run perf` | Benchmark de desempenho no build de produção (ver docs/PERFORMANCE.md) |
| `npm run typecheck` | Verificação de tipos |
| `npm run build` | Build de produção em `dist/` |
| `npm run audit:prod` | Vulnerabilidades altas/críticas em dependências de produção |

## Segurança e privacidade

- **Local-first:** os quadros ficam no IndexedDB **deste navegador**. Não há conta nem sincronização com servidores. Limpar os dados do site apaga os quadros — **exporte backups** (Exportar → Backup do workspace) regularmente.
- **Importar arquivos de terceiros:** backups passam por validação de formato e por um orçamento de complexidade; o tipo de anexos é decidido pelo conteúdo real; HTML/JavaScript personalizado entra **desativado** até você ativá-lo. Mesmo assim, importe apenas arquivos de origem confiável.
- **Finanças pessoais (ciclo F1):** contas e extratos ficam num banco local **separado** dos quadros (`aurora-finance`), não vão nos backups dos quadros e não são enviados à IA sem autorização confirmada em cada bloco. O armazenamento local não é cifrado (só os backups financeiros podem ser). Ver [`docs/finance/FINANCIAL_PRIVACY.md`](docs/finance/FINANCIAL_PRIVACY.md).
- **Meu Pluggy (dados bancários reais, somente leitura):** credenciais só no `.env` do servidor local; o navegador nunca as vê. Nenhuma conta é conectada sem você autorizar no portal da Pluggy. Ver [`docs/finance/MEU_PLUGGY.md`](docs/finance/MEU_PLUGGY.md).
- **Servidor local de IA:** só para uso no próprio computador (`127.0.0.1`, sem autenticação, usa as **suas** chaves). Não o exponha (túnel, proxy reverso, `vite --host`).
- **Beta público:** apenas o frontend estático, em HTTPS, com CSP e cabeçalhos de segurança; sem servidor de IA (as integrações de IA não estão disponíveis nessa versão) e sem ferramentas de depuração.
- **Limites:** nenhuma medida torna o sistema totalmente seguro; riscos conhecidos estão em [`docs/KNOWN_ISSUES.md`](docs/KNOWN_ISSUES.md) e [`docs/security/S1-FINAL-SECURITY-REPORT.md`](docs/security/S1-FINAL-SECURITY-REPORT.md).
- **Reportar vulnerabilidades:** de forma privada (GitHub › Security › *Report a vulnerability*), sem dados pessoais nem chaves reais. Detalhes em [`docs/SECURITY.md`](docs/SECURITY.md).

## Documentação

| Documento | Conteúdo |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Camadas, decisões, fluxos, pontos de extensão |
| [docs/PERSISTENCE.md](docs/PERSISTENCE.md) | Autosave por revisões, diário de recuperação, integridade, backups |
| [docs/SECURITY.md](docs/SECURITY.md) | Servidor local, SSRF, IA, sandbox de plugins, integrações futuras |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Testes, depuração de falhas, CI e artefatos, reprodução de bugs |
| [docs/PERFORMANCE.md](docs/PERFORMANCE.md) | Benchmark, medições antes/depois, limites |
| [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) | Problemas e limitações conhecidos |
| [docs/AI_ACTIONS.md](docs/AI_ACTIONS.md) | Ações da IA (contrato v2): blocos de valor, lançamentos financeiros, validação, prévia e confirmação |
| [docs/AI_TILES.md](docs/AI_TILES.md) | AI Tiles: decisões, modos visual/funcional, procedência e condições de uso das logos |
| [docs/SMART_LINKS.md](docs/SMART_LINKS.md) | Smart Links (L1): atalhos visuais `[ícone] Nome`, clique × arrasto, ícones locais, imagens, privacidade, compatibilidade |
| [docs/finance/PERSONAL_FINANCE.md](docs/finance/PERSONAL_FINANCE.md) | Minhas contas (ciclo F1): contas, cartões, extratos, conciliação, canvas, IA, backups — índice dos documentos em `docs/finance/` |
| [docs/finance/MEU_PLUGGY.md](docs/finance/MEU_PLUGGY.md) | Meu Pluggy (uso pessoal, somente leitura): passo a passo de configuração local, arquitetura, decisões e testes |
| [docs/HTML_DATA_BRIDGE.md](docs/HTML_DATA_BRIDGE.md) | HTML Data Bridge (protocolo 1): entradas/saídas tipadas para widgets HTML, IA só com saídas autorizadas, proteção financeira transitiva |
| [docs/HTML_NETWORK_BRIDGE.md](docs/HTML_NETWORK_BRIDGE.md) | HTML Network Bridge (H2): `aurora.request()` — GET a APIs HTTPS autorizadas pelo servidor local, confirmação por bloco/destino, dados sensíveis só com autorização específica, proteções SSRF ([modelo de ameaça H2](docs/security/H2-NETWORK-THREAT-MODEL.md)) |
| [docs/DATA_HUB.md](docs/DATA_HUB.md) | Data Hub: bloco “Dados importados” (CSV/JSON), persistência local, exportação segura, saídas limitadas e política de backup |
| [docs/PANELS.md](docs/PANELS.md) | Laterais redimensionáveis (arrastar, teclado, padrão) e formulários de Propriedades responsivos |
| [docs/ANIMATED_GIFS.md](docs/ANIMATED_GIFS.md) | GIFs animados (ciclo 6): auditoria do suporte nativo, repetição, pausa, movimento reduzido, exportação, limites |
| [docs/VISUAL_FINANCE.md](docs/VISUAL_FINANCE.md) | Finanças visuais: valores, meses, regras de cálculo, precisão, uso e desempenho |
| [docs/FORMULA_ENGINE.md](docs/FORMULA_ENGINE.md) | Motor de fórmulas: gramática, funções, tipos, variáveis |
| [docs/DATAFLOW_PORTS.md](docs/DATAFLOW_PORTS.md) | Fluxo de dados: portas explícitas, tipos, estados das conexões, compatibilidade |
| [docs/SPATIAL_NAVIGATION.md](docs/SPATIAL_NAVIGATION.md) | Checkpoints espaciais: criar, indicadores nas bordas, navegar, persistência |
| [docs/CAMERA_ENGINE.md](docs/CAMERA_ENGINE.md) | Motor de câmera: zoom suave, sensibilidade, animação, cancelamento, movimento reduzido |
| [docs/AUDIT-CYCLE2.md](docs/AUDIT-CYCLE2.md) | Auditoria inicial do ciclo 2 (baseline) |

---

## Status das funcionalidades

Legenda: ✅ implementado e testado · 🟡 implementado, depende de configuração externa · 🔜 previsto na arquitetura, não implementado.

### Editor visual
- ✅ **Navegação espacial (ciclo 5):** zoom suave e ancorado no cursor, com sensibilidade ajustável (Preciso/Suave/Normal/Rápido/Personalizado); **checkpoints** nomeados em qualquer ponto do quadro, com indicadores presos às bordas apontando na direção real, painel **Locais** (`G`) e viagem suave até cada local — trajeto de voo com duração proporcional à distância e preferência pessoal **Animação de navegação** (Sistema/Sempre/Nunca; Rápida/Suave/Cinematográfica, issue #12). Ver [docs/SPATIAL_NAVIGATION.md](docs/SPATIAL_NAVIGATION.md).
- ✅ **Aurora Wheel (issue #15):** segure o botão direito num espaço vazio para abrir a roda de criação (Nota, Texto, Tarefa, Forma, Conexão, Assistente IA, Valor, Mais); clique direito curto continua abrindo o menu de sempre. Teclado: `W`. Favoritos configuráveis. Ver [docs/RADIAL_MENU.md](docs/RADIAL_MENU.md).
- ✅ **Command Center (issue #14):** `Ctrl+K` busca em todos os quadros (sem acento, vários termos, filtros), vai até o item com a câmera e oferece ações; **Captura rápida** (`Ctrl+Shift+Espaço`) de nota/tarefa no quadro atual ou num Inbox, sem sair do lugar. Local, sem LLM; conteúdo de IA, HTML e finanças não é indexado. Ver [docs/COMMAND_CENTER.md](docs/COMMAND_CENTER.md).
- ✅ **AI Companions (issue #13):** o Assistente IA pode virar um **personagem** animado no quadro (Aurora, Sol, Nimbus), com mini chat, dock lateral e estados reais (aguardando, resposta, erro, nova resposta) — mesmo histórico, contexto e autorizações do bloco clássico. Ver [docs/AI_COMPANIONS.md](docs/AI_COMPANIONS.md).
- ✅ Canvas infinito: zoom pela roda (configurável para “navegar”), pinça do touchpad, Ctrl+roda, botões, zoom focado no cursor, enquadrar tudo, zoom na seleção, pan com mão / Espaço / botão do meio / dois dedos.
- ✅ Ferramentas: seleção, mão, retângulo, losango, elipse, seta, linha, desenho livre (pressão de caneta), texto, nota adesiva, borracha, frame, imagem, conectar.
- ✅ Selecionar (clique, Shift+clique, área; arrastar dentro da caixa da seleção move a seleção mesmo com outro elemento por cima), arrastar, redimensionar (8 alças, Shift = proporção, Alt = do centro), rotacionar (Shift = 15°), duplicar (Ctrl+D, Alt+arrastar), copiar/recortar/colar (também imagens e texto da área de transferência; URL colada vira atalho visual `[ícone] Nome`), excluir, bloquear, camadas, agrupar/desagrupar (grupos aninhados; duplo clique entra no grupo), alinhar, mover com setas do teclado, desfazer/refazer (histórico por quadro).
- ✅ Texto: duplo clique (ou Enter) em forma escreve dentro dela (o texto acompanha mover/redimensionar/rotacionar; a forma cresce para caber e alarga em vez de quebrar palavras); texto independente com alças laterais para quebrar linha e cantos para escalar a fonte; S/M/L/XL + tamanho livre; fontes Manual (Kalam), Sans (Inter), Mono (JetBrains Mono), Serifada (Lora); alinhamento horizontal e vertical; cor; opacidade.
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
| Notas | ✅ | Markdown com pré-visualização sanitizada (DOMPurify); com o bloco selecionado, o texto pode ser selecionado com o mouse |
| Tarefas | ✅ | Estados, prioridades, prazos, recebe tarefas por conexão de dados |
| Finanças | ✅ | Receitas/despesas, categorias, vencimentos, parcelas, período, 3 moedas, 3 formatos, saldo previsto e realizado, entradas por conexão |
| Calendário | ✅ local · 🔜 Google | Mês, eventos com horário. Google Calendar exige OAuth (não implementado) |
| Documentos | ✅ | Arquivos guardados no IndexedDB (até 25 MB cada) ou referências por URL; prévia de imagem, PDF e texto |
| Imagem | ✅ | Inserir por botão, colar ou arrastar arquivo. **GIFs animados** repetem continuamente no canvas, com pausar/reproduzir por imagem, preferência geral e respeito ao movimento reduzido; PNG/SVG exportam o primeiro quadro e o JSON preserva o GIF (ciclo 6, [docs/ANIMATED_GIFS.md](docs/ANIMATED_GIFS.md)) |
| Link / Smart Link | ✅ · 🟡 prévia | **Atalho visual** `[ícone] Nome` clicável (layouts horizontal, compacto e card; ícones locais, imagem enviada ou imagem do site com permissão; configuração em Propriedades) ou modo **Clássico** com URL/descrição no bloco (padrão de links antigos). Prévia Open Graph só por ação explícita, via servidor local (bloqueia endereços de rede local). Ver [docs/SMART_LINKS.md](docs/SMART_LINKS.md) |
| Código | ✅ | Destaque de sintaxe (10 linguagens), Tab, copiar |
| Assistente IA | 🟡 | OpenAI, Claude e Gemini via servidor local; só envia contexto conectado e autorizado; respostas estruturadas viram blocos/tarefas/conexões **somente após confirmação** |
| Gráfico | ✅ | Barras/rosca a partir de blocos financeiros conectados |
| HTML isolado | ✅ experimental | Base de plugins de terceiros (iframe sandbox + CSP); ponte de dados com entradas/saídas tipadas e IA só com saídas autorizadas (docs/HTML_DATA_BRIDGE.md); consultas GET a APIs HTTPS autorizadas com `aurora.request()` pelo servidor local, painel “Acesso à rede” e exemplo de dashboard público (docs/HTML_NETWORK_BRIDGE.md) |
| Dados importados | ✅ | CSV/JSON com prévia e validação, guardados no dispositivo, exportação CSV/JSON segura, saídas paginadas e agrupamento nativo para Fórmula/Gráfico/HTML, dashboard HTML conectado em um clique; IA só com consentimento granular e autorização local (docs/DATA_HUB.md) |
| AI Tiles | ✅ | ChatGPT, Codex, Claude, Claude Code, Gemini e Grok com logos locais; modos compacto, normal e detalhado; arrastar da biblioteca, conectar, agrupar, exportar PNG/SVG com a logo. Não exige API; vínculo opcional com um bloco Assistente IA. Ver [docs/AI_TILES.md](docs/AI_TILES.md) |
| Valor | ✅ | Dinheiro (receita/despesa/neutro, em centavos), número ou porcentagem; digita-se no próprio bloco; “Converter em valor” transforma um texto com número |
| Mês financeiro | ✅ | Soma os valores conectados: receitas, despesas, saldo, comprometimento, categorias; sem dupla contagem; avisa moeda/competência diferentes |
| Consulta bancária | ✅ | Receitas, despesas, resultado ou saldo das contas de **Minhas contas**, por período e categoria; alimenta Mês, Fórmula e Gráfico; o quadro guarda só a consulta. Ver [docs/finance/PERSONAL_FINANCE.md](docs/finance/PERSONAL_FINANCE.md) |
| Fórmula | ✅ | `=SOMA(saldo_janeiro, saldo_fevereiro)`, `=salario * 20%`… parser próprio (sem eval), dinheiro exato, moedas nunca misturadas. Ver [docs/VISUAL_FINANCE.md](docs/VISUAL_FINANCE.md) |
| Google Calendar, Google Drive, GitHub, API externa, Indicadores, Dashboard, Ferramentas de dev | 🔜 | Listados na biblioteca como “Futuro”, com o requisito de ativação |

### Dados
- ✅ Layout responsivo: em telas estreitas os painéis viram sobreposições; toque, desenho com o dedo e pinça para zoom.
- ✅ Workspaces → quadros → elementos; criar, renomear, descrever, duplicar, reordenar, pesquisar, arquivar, excluir (com confirmação).
- ✅ Salvamento automático no IndexedDB com **controle de revisões** (uma gravação antiga nunca confirma uma alteração mais nova) + **diário de recuperação por quadro** no `localStorage`; novas tentativas automáticas em caso de falha; dados inconsistentes são reparados ao abrir, com cópia do original. Ver [docs/PERSISTENCE.md](docs/PERSISTENCE.md).
- ✅ Exportar JSON (quadro ou workspace inteiro, com imagens/arquivos), PNG e SVG (quadro, seleção, com/sem fundo, fontes embutidas).
- ✅ Importar JSON: sempre **como novos quadros**, com relatório e avisos antes de confirmar; nunca sobrescreve.
- ✅ **Minhas contas (ciclo F1):** contas e cartões, importação de extratos **CSV/OFX** com prévia e confirmação, deduplicação idempotente, conciliação de transferências e faturas, categorias e regras locais, histórico com reversão, backups financeiros separados (cifra opcional) e provedor Open Finance **fictício** para testes. **Nenhuma conexão bancária real** — ver [docs/finance/OPEN_FINANCE.md](docs/finance/OPEN_FINANCE.md).
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

`Ctrl+setas` fluxograma · `Alt+setas` navegar · `Ctrl+Alt+C/V` estilo · `Ctrl+A/C/X/V/D` · `Ctrl+G` / `Ctrl+Shift+G` · `Ctrl+Z` / `Ctrl+Shift+Z` / `Ctrl+Y` · `Ctrl+Shift+L` bloquear · `Ctrl+]`/`[` camadas · `Delete` · `Esc` · `Enter` editar texto (ou abrir o atalho visual selecionado) · setas movem · `Shift+1` enquadrar · `Shift+2` zoom na seleção · `Ctrl+0/+/−` zoom · `G` Locais (checkpoints) · `W` Aurora Wheel (ou segurar o botão direito) · `Ctrl+K` Command Center · `Ctrl+Shift+Espaço` captura rápida · `Esc` interrompe a navegação · `?` ajuda. Atalhos de letra são ignorados enquanto se digita em campos.

---

## Testes e verificação

Antes de cada commit: `npm run verify` (tipos + unitários + build + E2E no Chromium). Detalhes, depuração de falhas, traces e artefatos do CI: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

- `npm test` — testes unitários: núcleo do editor, persistência sob concorrência (gravações controladas), integridade de dados, segurança do servidor (SSRF com DNS/transporte simulados), sandbox de plugins, finanças, fluxo de dados, IA.
- `npm run test:e2e` / `npm run test:e2e:all` — mouse e teclado reais em Chromium (padrão) ou Chromium, Firefox, WebKit e celular com toque.
- **CI** (`.github/workflows/ci.yml`): a cada push na `main`, em branches `improvement/**` e `feature/**` e em pull requests roda tipos, unitários, build, auditoria de dependências e E2E nos quatro projetos, publicando relatório/traces quando algo falha. Os testes de navegador rodam na imagem oficial do Playwright fixada por versão e digest, sem instalar dependências via apt a cada execução (ciclo CI-1, [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#navegadores-na-ci-ciclo-ci-1-25)).

Critério 18 (IA com credenciais válidas): o contrato de requisição/resposta de cada provedor é testado com `fetch` simulado; **uma chamada real não foi verificada** porque não havia chave disponível no ambiente de desenvolvimento.

Desempenho (build de produção, i5-1135G7, Chromium, 1440×900): com zoom de trabalho, arrastar/zoom/pan ficam em ~2 quadros (≈30 ms) mesmo com 5.000 elementos; com 5.000 elementos **todos visíveis**, o trabalho de JS por passo de arrasto caiu de 68,5 ms para 9 ms no ciclo 2 e o limite passa a ser a pintura. Detalhes em [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

## Limitações conhecidas / próximos passos

Lista completa em [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md). Principais:

- Milhares de elementos visíveis ao mesmo tempo: a pintura do DOM/SVG limita pan/zoom (80–150 ms por quadro); próximo passo é um nível de detalhe com `<canvas>` em zoom distante.
- Diário de recuperação limitado pelo `localStorage` (~5 MB): quadros acima de ~10.000 elementos.
- Integrações Google (Calendar/Drive), GitHub e demais “Futuro” não implementadas (exigem OAuth/infra).
- Open Finance real não conectado (exige intermediário contratado e backend seguro); armazenamento financeiro local sem cifra própria.
- Sincronização com backend e colaboração em tempo real: arquitetura preparada (`PersistenceAdapter`), não implementada.
- Recorte visual de frames e desvio de obstáculos em setas de cotovelo ainda não existem; importação de `.excalidraw` não suportada.
- Bundle de ~730 KB (230 KB gzip): candidatos a carregamento sob demanda são highlight.js e o bloco de IA.
- HTML Network Bridge: só GET/HTTPS/JSON-texto, sem redirecionamentos nem cabeçalhos próprios; só no computador principal com servidor local (docs/KNOWN_ISSUES.md).
- O servidor local não tem autenticação: é para uso local (`127.0.0.1`), protegido contra sites visitados (ver docs/SECURITY.md).
