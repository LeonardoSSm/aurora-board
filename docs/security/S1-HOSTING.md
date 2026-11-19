# S1 — Hospedagem do frontend estático

> Nada aqui publica o site sozinho. Este documento descreve o que está pronto e os passos manuais que
> dependem de uma conta de hospedagem (não disponível neste ciclo).

## O que vai para a hospedagem

`npm run build` gera `dist/` — o **build público padrão**:

| Contém | Não contém |
|---|---|
| `index.html` (com CSP em `<meta>`), `assets/*` com hash, `sandbox.html`, `_headers`, `favicon.svg` | servidor Node (`server/`), `.env`, chaves, `window.__aurora`, rotas `/api`, source maps, dados de teste |

Verificado em CI (job *Build de produção (público)*) por `grep`: sem `__aurora`, sem `/api/ai`/`/api/link-preview`,
sem `*.map`, sem padrões de chave de API.

Variáveis de build (somente para builds **locais**, nunca na hospedagem):

| Variável | Efeito |
|---|---|
| `VITE_AURORA_LOCAL_API=1` | o build conversa com o servidor local (`/api`) — uso pessoal com `npm run server:start` |
| `VITE_AURORA_TEST_HOOKS=1` | expõe `window.__aurora` (benchmarks) |

## Cabeçalhos (fonte: `hosting/headers.ts`)

Arquivos gerados com `npm run hosting:generate` e verificados por `tests/unit/hosting.test.ts` e pela CI:

- `public/_headers` → copiado para `dist/_headers` (**Cloudflare Pages**; a sintaxe `! Cabeçalho` usada para o
  `/sandbox.html` é da Cloudflare — a Netlify não a suporta e exigiria ajuste).
- `vercel.json` → **Vercel**, com `git.deploymentEnabled: false` (conectar o repositório não publica a `main`).

| Cabeçalho | App | `/sandbox.html` |
|---|---|---|
| `Content-Security-Policy` | `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob: https:; font-src 'self' data:; connect-src 'self'; media-src 'self' data: blob:; frame-src 'self'; child-src 'self'; worker-src 'none'; object-src 'none'; manifest-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` | `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'; frame-ancestors 'self'` |
| `X-Frame-Options` | `DENY` | `SAMEORIGIN` |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` (sem `preload` — decisão do dono do domínio) | idem |
| `X-Content-Type-Options` | `nosniff` | idem |
| `Referrer-Policy` | `no-referrer` | idem |
| `Permissions-Policy` | câmera, microfone, geolocalização, pagamento, USB, serial, bluetooth, HID, MIDI, captura de tela, sensores, topics: `()` | idem |
| `Cross-Origin-Opener-Policy` / `-Resource-Policy` | `same-origin` | idem |
| `Cache-Control` | `/` e `/index.html`: `no-cache`; `/assets/*`: `public, max-age=31536000, immutable` | — |

### Por que cada exceção existe

- **`style-src 'self'` sem `unsafe-inline`:** estilos de componentes React são aplicados via CSSOM (não bloqueado).
- **`img-src https:`:** só é usado quando o **usuário clica** para carregar uma imagem externa (Markdown, prévia de link).
  Abrir um quadro não dispara nenhuma requisição externa (verificado no E2E do build público).
- **`font-src data:`:** fontes embutidas no SVG usado pela exportação PNG/SVG. Fontes não executam código.
- **`frame-src 'self'`:** o único iframe é `/sandbox.html`. Navegação do frame para outra origem é bloqueada; para a
  mesma origem o host detecta o segundo `load` e desmonta o widget.
- **`/sandbox.html` com `'unsafe-inline'`:** é o documento que executa o HTML do usuário. Ele roda **sempre** como
  `<iframe sandbox="allow-scripts">` (origem opaca: sem cookies, storage, DOM do app) e se recusa a executar se
  aberto fora desse contexto (`self.origin !== 'null'`). Um `srcdoc` herdaria a CSP do app e os widgets não rodariam.

## Validação em duas fases (feita localmente e repetida na CI, 3 navegadores)

```bash
AURORA_CSP_MODE=report-only npm run test:static   # fase 1: CSP só reporta — lista violações
npm run test:static                                # fase 2: CSP aplicada (cabeçalho + meta)
```

`vite preview` serve os mesmos cabeçalhos, por caminho (plugin em `vite.config.ts`). A jornada
`e2e/static/public-build.spec.ts` (só UI) importa um backup variado, ativa um widget HTML, exporta PNG/SVG/JSON,
reimporta, recarrega e falha em qualquer violação de CSP, requisição externa, chamada a `/api` ou `window.__aurora`.

Fase 1 encontrou três violações reais, corrigidas na raiz (não afrouxando `script-src`):
1. `srcdoc` do sandbox herdava a CSP → `/sandbox.html` como documento próprio;
2. sonda `Function('')` do Zod → `z.config({ jitless: true })`;
3. fontes `data:` da exportação → `font-src 'self' data:`.

## Passos manuais para homologação (pendentes — dependem de conta)

1. Criar um projeto **de homologação** (ex.: Cloudflare Pages com domínio `*.pages.dev`, ou Vercel *Preview*).
   Build: `npm ci && npm run build`; saída: `dist`. **Não** definir variáveis `VITE_AURORA_*`.
2. Publicar manualmente uma branch (não a `main`) e conferir:
   - `curl -sI https://<homologação>/` → cabeçalhos da tabela acima; `curl -sI https://<homologação>/sandbox.html`;
   - `curl -s https://<homologação>/api/ai/providers` → 404 (não existe API);
   - `/.env`, `/server/index.ts`, `/package.json` → não servidos;
3. Rodar a jornada contra a URL: `AURORA_STATIC_BASE_URL=https://<homologação> npm run test:static`
   (registrar o resultado no checklist).
4. Validar em celular real (Android/iOS): importar backup, ativar HTML, exportar, recarregar.

Nenhuma URL pública foi criada neste ciclo.
