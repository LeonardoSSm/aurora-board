# Ícones de marca dos Smart Links

Arquivos locais usados pelo modo Atalho Visual do widget Link (`aurora.link`, issue #22). Nenhum depende de CDN
nem é baixado em tempo de execução.

| Arquivo | Marca | Titular | Cor (Simple Icons) | Origem do vetor |
|---|---|---|---|---|
| `youtube.svg` | YouTube | Google | `#FF0000` | Simple Icons 16.38.0 (`youtube.svg`) |
| `youtubestudio.svg` | YouTube Studio | Google | `#FF0000` | Simple Icons 16.38.0 (`youtubestudio.svg`) |
| `tiktok.svg` | TikTok | ByteDance | `#000000` | Simple Icons 16.38.0 (`tiktok.svg`) |
| `instagram.svg` | Instagram | Meta | `#FF0069` | Simple Icons 16.38.0 (`instagram.svg`) |
| `facebook.svg` | Facebook | Meta | `#0866FF` | Simple Icons 16.38.0 (`facebook.svg`) |
| `x.svg` | X | X Corp. | `#000000` | Simple Icons 16.38.0 (`x.svg`) |
| `github.svg` | GitHub | GitHub/Microsoft | `#181717` | Simple Icons 16.38.0 (`github.svg`) |
| `whatsapp.svg` | WhatsApp | Meta | `#25D366` | Simple Icons 16.38.0 (`whatsapp.svg`) |

Os vetores do Simple Icons são distribuídos sob **CC0 1.0** (domínio público). As marcas continuam pertencendo
aos seus titulares: o uso aqui é referencial — identificar o destino de um atalho no quadro do próprio usuário,
sem sugerir parceria ou endosso. Os ícones genéricos vêm do `lucide-react` instalado (licença ISC), gerados em
`src/widgets/builtin/linkIconNodes.ts`.

Regras para quem mexer aqui:

- Arquivos copiados sem alteração do pacote `simple-icons@16.38.0` (npm). O app lê só o atributo `d` do único
  `<path>`; o arquivo inteiro nunca é injetado na página.
- Não inserir `<script>`, `foreignObject`, atributos `on*` nem `href` externos (há teste unitário que verifica).
- Adicionar marca nova só com vetor de fonte com licença clara (CC0/MIT/ISC) e registrar aqui.
