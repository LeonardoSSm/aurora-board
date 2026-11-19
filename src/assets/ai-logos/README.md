# Logos de assistentes de IA

Arquivos locais usados pelos AI Tiles (`aurora.ai-tile`). Nenhum depende de CDN.

| Arquivo | Marca | Titular | Origem do vetor |
|---|---|---|---|
| `openai.svg` | OpenAI (símbolo usado pelo ChatGPT) | OpenAI | Lobe Icons 1.104.0 (`openai.svg`) |
| `codex.svg`, `codex-color.svg` | Codex | OpenAI | Lobe Icons 1.104.0 (`codex*.svg`) |
| `claude.svg`, `claude-color.svg` | Claude | Anthropic | Lobe Icons 1.104.0; geometria conferida com Simple Icons 16.38.0 (`claude.svg`, fonte declarada: claude.ai) |
| `claudecode.svg`, `claudecode-color.svg` | Claude Code | Anthropic | Lobe Icons 1.104.0; geometria conferida com Simple Icons 16.38.0 (`claudecode.svg`, fonte declarada: code.claude.com) |
| `gemini.svg`, `gemini-color.svg` | Gemini | Google | Lobe Icons 1.104.0; geometria conferida com Simple Icons 16.38.0 (`googlegemini.svg`, fonte declarada: gemini.google.com) |
| `grok.svg` | Grok | xAI | Lobe Icons 1.104.0 (`grok.svg`) |

Detalhes, condições de uso e decisões: [docs/AI_TILES.md](../../../docs/AI_TILES.md#procedência-das-logos).

Regras para quem mexer aqui:

- Não editar a geometria nem as cores dos arquivos `-color`. Os arquivos monocromáticos usam `currentColor`, que o app troca só por branco ou preto.
- Não inserir `<script>`, `foreignObject`, atributos `on*` nem `href` externos (há teste unitário que verifica).
- As marcas pertencem aos seus titulares. O uso aqui é referencial: identificar a ferramenta no quadro do próprio usuário, sem sugerir parceria ou endosso.
