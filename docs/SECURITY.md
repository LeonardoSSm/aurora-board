# Segurança

O Aurora Board é um app **local**: o frontend roda no navegador e o servidor (`server/`) escuta só em `127.0.0.1`. Não há autenticação — o modelo de ameaça é proteger o usuário de **sites que ele visita** e de **conteúdo importado**, não de outros usuários da mesma máquina.

## Superfície e proteções

### Servidor local (`server/app.ts`)

| Risco | Proteção | Teste |
|---|---|---|
| Site visitado faz POST “simples” (`text/plain`, sem preflight) para `127.0.0.1:8787` e gasta créditos de IA / usa o proxy | `Origin` precisa ser local; POST exige `Content-Type: application/json` (força preflight, que não é respondido com CORS) | `security.test.ts` › Origin estrangeira / text/plain |
| DNS rebinding (domínio do atacante passa a resolver para 127.0.0.1) | Cabeçalho `Host` precisa ser `localhost`, `127.0.0.1` ou `[::1]` | › Host forjado |
| Chave de API ecoada pelo provedor em mensagens de erro | `redactSecrets` antes de responder e de registrar no log | › chave ecoada… |
| Chamada cara continua após o usuário cancelar | Fechar a conexão aborta a requisição ao provedor | › cancelar no cliente… |
| Corpo enorme / JSON inválido / provedor `__proto__` | Limite de 2 MB, validação estrita, `hasOwnProperty` | › provedor não configurado… |

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

### Plugins e widgets HTML (`src/widgets/builtin/sandbox.tsx`, `thirdParty.tsx`)

| Proteção | Detalhe |
|---|---|
| Isolamento | `<iframe sandbox="allow-scripts">` **sem** `allow-same-origin`: origem opaca, sem acesso a cookies, IndexedDB, localStorage ou DOM do app; sem popups, formulários ou navegação do topo |
| CSP | `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'` — sem rede |
| Mensagens | Aceitas apenas da janela do próprio iframe; só `{type:'aurora:setState', state}`; JSON ≤ 100 KB; campos extras e estruturas circulares recusados |
| Frequência | No máximo 10 atualizações/s por iframe (as excedentes viram uma só, a última) — evita inundar histórico e autosave |
| Código × estado | Plugins de terceiros: o HTML vem do manifesto validado; o quadro guarda só o estado. Prefixo `aurora.` reservado |
| Permissões | Declaradas no manifesto e exibidas; hoje **informativas** — o isolamento é garantido pelo sandbox/CSP, não pelas permissões |

Limitação: o widget nativo “HTML isolado” guarda o HTML no próprio quadro (é conteúdo do usuário). Um quadro importado de terceiros pode trazer HTML — ele roda isolado e sem rede, mas o usuário deve importar apenas arquivos confiáveis.

### Conteúdo renderizado

- Markdown das notas: `marked` + `DOMPurify` (sem `style`, `iframe`, `form`; links com `noopener noreferrer`).
- Links e imagens de pré-visualização: só `http(s)`; imagens com `referrerPolicy="no-referrer"`.
- Documentos: PDF em iframe via blob URL; texto exibido como texto (nunca HTML).

## Integrações futuras (Google Calendar, Drive, GitHub…)

Os contratos atuais (`registerPlanned`, permissões `external:*`) continuam válidos. Requisitos para implementá-las:
1. Fluxo OAuth e **tokens apenas no servidor** (nunca em `localStorage`/IndexedDB do frontend).
2. Escopos mínimos (ex.: `calendar.readonly`), declarados como permissões do widget e confirmados pelo usuário.
3. Toda ação externa que escreva ou apague exige confirmação explícita; conexões visuais nunca executam nada.
4. Requisições de saída para APIs fixas (não para URLs arbitrárias) — se precisarem de URL do usuário, usar `safeFetchText`.

## Reportar problemas

Abra uma issue privada no repositório descrevendo o cenário; não inclua chaves reais.
