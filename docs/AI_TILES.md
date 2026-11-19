# AI Tiles

Blocos pequenos com a identidade visual de assistentes de IA (ChatGPT, Codex, Claude, Claude Code, Gemini, Grok). Funcionam como qualquer elemento do quadro: selecionar, mover, redimensionar, agrupar, conectar, copiar, bloquear, desfazer, salvar e exportar. Nenhuma API é necessária.

## Decisões

| Decisão | Motivo |
|---|---|
| Um único widget nativo `aurora.ai-tile`, com os seis assistentes como **presets** | Evita seis implementações; o preset só define dados iniciais (`providerId`). |
| Sem novo tipo no esquema principal | O tile é um `WidgetElement` comum; os dados ficam em `element.data` e passam pela persistência, histórico, importação e exportação já existentes. |
| Moldura `bare` no contrato `WidgetPlugin` (`frame: 'bare'`) | O `WidgetFrame` padrão tem cabeçalho de 40 px; widgets compactos declaram `frame: 'bare'` e desenham a área inteira. Não há `if (aiTile)` espalhado. |
| Presets na biblioteca via `WidgetPlugin.presets` + `librarySection` | Qualquer widget futuro pode oferecer variações na biblioteca (clique ou arrastar) sem código novo no painel. |
| Configuração no Inspetor (`WidgetPlugin.Inspector`) exibido no painel de propriedades | Um só lugar para editar; o duplo clique (`WidgetPlugin.onDoubleClick`) e o menu “Editar tile” abrem esse painel. |
| Itens de menu por plugin (`WidgetPlugin.menuItems`) | Ações do tile (abrir ferramenta, alternar modo, vincular) sem remover as ações genéricas. |
| Mesmo layout para tela e exportação (`aiTileLayout`) | A tela renderiza o layout como SVG React; a exportação serializa o mesmo layout em SVG. Sem divergência visual. |
| Logos como `<image href="data:image/svg+xml…">` | Isola ids de gradientes entre instâncias, funciona em PNG e SVG exportados e não depende de rede. |
| Estado de integração calculado, nunca gravado | “Configurado” só aparece quando o tile está vinculado a um bloco de IA cujo provedor tem chave no servidor (`/api/ai/providers`). |

## Uso

- **Inserir:** biblioteca → “Inteligências Artificiais” → clique (centro da tela) ou arraste até o ponto desejado. A busca encontra por nome ou empresa (“anthropic”, “google”…).
- **Editar:** duplo clique no tile (ou botão direito → “Editar tile”) abre as configurações no painel de propriedades: assistente, nome (campo do componente), descrição, modo, mostrar nome/descrição, fundo (escuro, transparente, marca), logo original ou monocromática, tamanho da logo, cor de destaque, borda colorida, arredondamento, opacidade, link e integração.
- **Menu de contexto:** Editar tile, alternar modo, Abrir ferramenta, Vincular assistente / Abrir assistente / Remover vínculo, além das ações genéricas.
- Trocar o modo aplica o tamanho de referência (64×64, 104×112, 200×150) mantendo o centro; depois disso o redimensionamento é livre.
- Abrir links só acontece por ação explícita (botão ou menu), em nova aba com `noopener,noreferrer`, e só para `https://` sem credenciais.

## Pontos de extensão criados (genéricos)

Em `WidgetPlugin` (`src/widgets/registry.ts`): `frame: 'bare'`, `presets` + `librarySection` + `hideInLibrary`, `onDoubleClick`, `menuItems`, `exportSVG`, `remapIds`. O painel de propriedades passou a exibir `Inspector` de qualquer widget. Nenhum desses pontos menciona o AI Tile; outro widget compacto usa o mesmo caminho.

## Testes

- Unitários (`tests/unit/ai-tiles.test.ts`, 45): presets, ids, logos locais e seguras, padrões, sanitização, URLs perigosas, estado de integração, layout (logo sem distorção em qualquer tamanho), escape na exportação, operações do quadro (inserir, modo + desfazer, duplicar, agrupar, bloquear, redimensionar, setas), cópia com vínculo, JSON exportar/importar, migração e compatibilidade.
- E2E (`e2e/ai-tiles.spec.ts`, Chromium/Firefox/WebKit; `e2e/mobile.spec.ts`, Pixel 7): jornada completa com as seis IAs (clique e arrastar da biblioteca), logos, arrastar, redimensionar com desfazer/refazer, agrupar, conectar, editar descrição, trocar modo, menu, recarregar, exportar SVG (seis logos embutidas, sem URL externa) e PNG (cores das marcas presentes nos pixels), exportar JSON e importar como novo quadro; link https e vínculo com estado honesto; Grok só visual.

## Visual e funcional

- **Visual (padrão):** o tile representa a ferramenta; setas são relações visuais.
- **Funcional (opcional):** o tile pode apontar para um bloco “Assistente IA” existente (ou criar um novo já vinculado e conectado por seta). “Abrir assistente” seleciona e enquadra esse bloco.
- Mapeamento de API: ChatGPT e Codex → API OpenAI; Claude e Claude Code → API Anthropic; Gemini → API Gemini; Grok → sem integração nesta versão. Isso só indica qual chave de API o bloco vinculado usa: assinatura de ChatGPT, Claude, Gemini ou Grok **não** dá acesso às APIs.

## Procedência das logos

Arquivos em `src/assets/ai-logos/` (tabela completa no README da pasta).

- Vetores copiados do pacote **Lobe Icons** (`@lobehub/icons-static-svg` 1.104.0, licença MIT do pacote). Para Claude, Claude Code e Gemini a geometria foi conferida com **Simple Icons** 16.38.0 (CC0), que registra a fonte oficial de cada marca. O Simple Icons não inclui OpenAI nem xAI/Grok.
- Existe símbolo próprio para **Codex** (ícone do produto) e para **Claude Code** (mascote em pixel); ambos são usados no lugar da marca da empresa.
- Ajustes feitos: remoção de `width/height/style` de embalagem e renomeação de ids internos de gradiente. Geometria e cores intactas.
- **As licenças acima cobrem os arquivos vetoriais, não as marcas.** OpenAI, ChatGPT, Codex, Anthropic, Claude, Claude Code, Google, Gemini, xAI e Grok são marcas de seus titulares. As diretrizes da Anthropic (anthropic.com/legal/trademark-guidelines) pedem que não se alterem cores, fontes ou proporções e que não se sugira parceria; as do Google proíbem distorcer ou alterar marcas; as páginas de marca da OpenAI e da xAI bloquearam leitura automatizada durante a pesquisa e não foram verificadas.
- Uso no Aurora Board: referencial, para o usuário identificar as ferramentas que ele usa no próprio quadro. O app não altera proporções (logos sempre com `preserveAspectRatio="xMidYMid meet"`), só oferece a versão colorida original ou monocromática em branco/preto. Antes de redistribuir o app comercialmente ou usar as marcas em material público, confirme as condições com cada titular.
