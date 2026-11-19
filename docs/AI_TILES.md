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
