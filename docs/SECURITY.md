# Segurança

O Aurora Board é **local-first**: os quadros ficam no IndexedDB do navegador. Há duas distribuições:

- **Local** (`npm run dev`): frontend + servidor (`server/`) que escuta só em `127.0.0.1`, sem autenticação, para IA e pré-visualização de links.
- **Pública estática** (`npm run build`): só o frontend, sem servidor, sem `/api`, sem ganchos de depuração — destinada ao beta em HTTPS.

O modelo de ameaça é proteger o usuário de **conteúdo que ele importa, cola ou anexa** e de **sites que ele visita**; não de outros usuários da mesma máquina. Achados, evidências e decisões do ciclo de segurança S1: [`docs/security/`](security/) — comece pelo [relatório final](security/S1-FINAL-SECURITY-REPORT.md). Nenhuma destas medidas torna o sistema "totalmente seguro".

## Superfície e proteções

### Servidor local (`server/app.ts`)

| Risco | Proteção | Teste |
|---|---|---|
| Site visitado faz POST “simples” (`text/plain`, sem preflight) para `127.0.0.1:8787` e gasta créditos de IA / usa o proxy | `Origin` precisa ser local; POST exige `Content-Type: application/json` (força preflight, que não é respondido com CORS) | `security.test.ts` › Origin estrangeira / text/plain |
| DNS rebinding (domínio do atacante passa a resolver para 127.0.0.1) | Cabeçalho `Host` precisa ser `localhost`, `127.0.0.1` ou `[::1]` | › Host forjado |
| Chave de API ecoada pelo provedor em mensagens de erro | `redactSecrets` antes de responder e de registrar no log | › chave ecoada… |
| Chamada cara continua após o usuário cancelar | Fechar a conexão aborta a requisição ao provedor | › cancelar no cliente… |
| Corpo enorme / JSON inválido / provedor `__proto__` | Limite de 2 MB, validação estrita, `hasOwnProperty` | › provedor não configurado… |
| Dev server exposto (`vite --host`) + `Host: localhost` forjado por vizinho de rede | Proxy do Vite e servidor recusam conexões cujo **endereço de socket** não é loopback (S1) | `server-hardening.test.ts` › endereço do par |
| Laço/abuso local gastando créditos | Chat: 30/min e 3 simultâneas; link preview: 60/min e 4; `429` + `Retry-After` (S1). Defesa em profundidade — **não é autenticação** | › limites de uso |

O bind é fixo em `127.0.0.1` (não há variável para `0.0.0.0`) e o servidor avisa ao iniciar: **não exponha esta porta** (túnel, proxy reverso, `docker -p`, `vite --host`). Um backend público exigiria outro ciclo: identidade de usuários, autorização por recurso, isolamento de dados, sessão, rate limit distribuído, cotas e limites financeiros por usuário, controle de uso das APIs, observabilidade, proteção contra abuso e auditoria de infraestrutura.

Confirmado antes da correção (ciclo 2): `POST text/plain` com `Origin` estrangeira era processado, e `Host: atacante.example` respondia 200.

### Pré-visualização de links — SSRF (`server/netSafety.ts`)

| Proteção | Detalhe |
|---|---|
| Protocolo, porta e credenciais | Só `http`/`https`, portas 80/443, sem `usuario:senha@` |
| Nomes locais | `localhost`, `*.localhost`, `*.local`, `*.internal`, nomes sem ponto, com ou sem ponto final |
| IPs proibidos | `net.BlockList`: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4; `::`, `::1`, fc00::/7, fe80::/10, fec0::/10, ff00::/8, 64:ff9b::/96, 2001::/23, 2001:db8::/32, 2002::/16; **qualquer IPv4 mapeado em IPv6** |
| DNS rebinding / TOCTOU | O DNS é validado **dentro da conexão** (opção `lookup` de `http.request`): o IP checado é o IP conectado. Respostas com qualquer IP proibido são recusadas inteiras |
| Redirecionamentos | Seguidos manualmente; cada `Location` é revalidado (URL + DNS); máximo 3 |
| Recursos | Timeout total 8 s; no máximo 512 KB lidos; status ≠ 2xx e redirect sem `Location` tratados |

Antes do ciclo 2 o código usava `fetch(..., { redirect: 'follow' })` com DNS checado separadamente — um redirect público → `169.254.169.254` ou um domínio com DNS alternante contornavam a checagem.

Limitação conhecida: um proxy HTTP do sistema (variáveis `HTTP_PROXY`) não é usado — e não deve ser, pois a resolução aconteceria fora do nosso `lookup`.

### IA (`server/providers.ts`, `src/integrations/`)

- Chaves só em `.env` do servidor; o frontend recebe apenas `configured: true/false`.
- **Assinatura do ChatGPT (Plus/Pro) não dá acesso à API.** É preciso uma chave da OpenAI Platform (cobrada à parte); o mesmo vale para Claude (Anthropic Console) e Gemini (Google AI Studio).
- O usuário escolhe o provedor; sem chave, o bloco mostra “Não configurado” e não simula respostas.
- Só é enviado o conteúdo de blocos ligados por conexões **contexto/dados** e marcados como autorizados; o painel “Ver o que será enviado” mostra o payload exato (`aiContext.test.ts`).
- Propostas estruturadas da IA são validadas com zod; ids de conexões precisam existir no contexto; criar/alterar blocos exige confirmação.

### Widgets HTML e plugins (`sandbox.tsx`, `public/sandbox.html`, `thirdParty.tsx`)

| Proteção | Detalhe |
|---|---|
| Isolamento | `<iframe sandbox="allow-scripts" src="/sandbox.html">` **sem** `allow-same-origin`: origem opaca, sem cookies, IndexedDB, localStorage ou DOM do app; sem popups, formulários ou navegação do topo |
| Documento próprio | `/sandbox.html` tem CSP própria (`default-src 'none'`, só inline) e **não herda** a CSP do app — um `srcdoc` herdaria e os widgets não rodariam com a CSP pública. Recusa-se a executar fora de um iframe sandboxed (`self.origin !== 'null'`) e só aceita mensagens de `window.parent` |
| Navegação | A CSP do app (`frame-src 'self'`) impede o frame de navegar para outra origem ou `data:`; navegação para a mesma origem é detectada (2º `load`) e o widget é desmontado; nada é aceito do documento navegado |
| Conteúdo importado | HTML vindo de **importação** ou **colagem externa** entra **desativado**; a marcação é do importador (um backup não consegue se declarar ativado). "Ver código" e "Ativar…" com confirmação; a decisão persiste. Editar e aplicar o HTML é autoria do usuário e o reativa |
| Limites | 20 iframes simultâneos (excedentes pausados; fora da tela já são desmontados), HTML ≤ 500 000 caracteres, mensagens ≤ 100 KB, 10 atualizações/s |
| Recuperação | `?safe` na URL desliga todo HTML personalizado na sessão |
| Plugins de terceiros | HTML do manifesto validado (nunca do quadro); prefixo `aurora.` reservado; permissões informativas |

Limites honestos: depois de ativado, um widget pode exibir conteúdo enganoso (phishing visual) — o isolamento impede acesso a dados, não impede texto falso. Widgets HTML importados **antes** do ciclo S1 não têm marcação e são tratados como locais.

### Documentos e mídias (`core/media.ts`, `documents.tsx`, `ElementView.tsx`)

- O tipo é decidido pelos **bytes** (assinatura), nunca por nome, extensão, MIME declarado ou cabeçalho do data URL.
- Imagens raster e SVG: só em contexto de imagem (`<img>`: sem scripts, sem rede); a prévia de SVG usa `data:`.
- Texto (inclusive HTML disfarçado): exibido como texto em `<pre>`, com aviso quando o tipo declarado diverge.
- **PDF: sem prévia embutida** (o iframe anterior executava HTML disfarçado de PDF com a origem do app — S1-SEC-001, P0). Só download.
- Download sempre `application/octet-stream`, com nome saneado: abrir o link numa aba não renderiza o arquivo.
- Imagens: dimensões lidas do cabeçalho; acima de 100 MP ou 30 000 px por lado (bomba de descompressão) não são decodificadas — o asset é preservado e um aviso aparece no lugar. Upload local confere a assinatura antes de gravar; limite de 25 MB.

### Importação de backups (`persistence/importBudget.ts`, `exportImport.ts`)

- Tamanho checado por `File.size` **antes** de ler (200 MB).
- Orçamento de complexidade numa passada iterativa **antes** da validação: 500 quadros; 100 000 elementos por quadro e 300 000 no total; 50 000 pontos por elemento e 3 000 000 no total; 2 M caracteres por texto; profundidade 48 e 200 000 nós por dado de widget; 200 widgets HTML (≤ 500 000 caracteres cada); 5 000 assets de até ~25 MB. Arquivo acima do orçamento é **recusado inteiro**, com a causa — nada é truncado em silêncio.
- Gravação **atômica** (uma transação IndexedDB para assets, quadros e workspace): ou tudo entra, ou nada.
- Configurações e cores validadas campo a campo; versão de esquema limitada; colagem externa passa pela mesma validação.

### Conteúdo renderizado

- Markdown das notas: `marked` + `DOMPurify` (sem `style`, `iframe`, `form`; links com `noopener noreferrer`).
- Links e imagens de pré-visualização: só `http(s)`; imagens com `referrerPolicy="no-referrer"`.
- **Privacidade:** imagens remotas (Markdown, prévia de link) só carregam **por clique**; abrir um quadro não faz requisições a terceiros. Campos de formulário, mídia, `link`/`meta`/`base`, `srcset` e `ping` são removidos do Markdown.

## Integrações futuras (Google Calendar, Drive, GitHub…)

Os contratos atuais (`registerPlanned`, permissões `external:*`) continuam válidos. Requisitos para implementá-las:
1. Fluxo OAuth e **tokens apenas no servidor** (nunca em `localStorage`/IndexedDB do frontend).
2. Escopos mínimos (ex.: `calendar.readonly`), declarados como permissões do widget e confirmados pelo usuário.
3. Toda ação externa que escreva ou apague exige confirmação explícita; conexões visuais nunca executam nada.
4. Requisições de saída para APIs fixas (não para URLs arbitrárias) — se precisarem de URL do usuário, usar `safeFetchText`.

## Build público, CSP e cabeçalhos

Ver [`security/S1-HOSTING.md`](security/S1-HOSTING.md): CSP sem `unsafe-inline`/`unsafe-eval` validada em duas fases (Report-Only → aplicada) em três navegadores, HSTS, `nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`, `frame-ancestors 'none'`. O build público não contém `window.__aurora`, rotas `/api`, source maps nem chaves (verificado na CI).

## Reportar problemas

Use o **Private vulnerability reporting** do GitHub (aba *Security* do repositório) ou contate o mantenedor em privado. Não abra issue pública com detalhes exploráveis e não inclua chaves reais nem dados pessoais. Informe commit/versão, navegador e um passo a passo com dados fictícios.
