# Homologação real do H2 — HTML Network Bridge

**Data:** 2026-11-21 · **Commit da main:** `3b978d7` · **Máquina:** Windows 11 x64, Node 24.15, Chromium do Playwright · **Rede:** internet real (sem interceptação).

Complementa os testes automatizados do H2 (que usam transporte/DNS simulados). Reproduzível com `npm run test:live` (exige internet; fora da CI). O teste sobe o Vite (5193) e o servidor local (8807) de verdade — sem `.env`, portanto sem chaves do usuário — e usa um perfil de navegador **persistente**.

| # | Verificação | Resultado | Evidência |
|---|---|---|---|
| 1 | Frontend + servidor local iniciados | ✅ | `GET /api/net/status` → `available: true` |
| 2 | Widget HTML usando `aurora.request()` | ✅ | bloco “GitHub ao vivo” |
| 3 | API pública HTTPS real (GitHub) | ✅ | `https://api.github.com/repos/LeonardoSSm/aurora-board` |
| 4 | Status, JSON e atualização visual | ✅ | widget: `200 \| LeonardoSSm/aurora-board \| <estrelas> \| application/json`; mesmo `full_name`/estrelas de uma consulta independente feita pelo Node |
| 5 | Autorização por domínio | ✅ | confirmação mostrou `https://api.github.com`; `https://httpbin.org` pediu **outra** autorização |
| 6 | Revogar e verificar bloqueio | ✅ | painel → Revogar GitHub → nova consulta pediu confirmação → Negar → `permission_denied`, **nenhuma** chamada a `/api/net/fetch` |
| 7 | Permissão permanente após reinício | ✅ | navegador fechado, Vite e servidor derrubados e reiniciados, mesmo perfil: httpbin respondeu sem confirmação; GitHub (revogado) continuou pedindo |
| 8 | Cancelamento | ✅ | `httpbin.org/delay/8` + `AbortController` após 1,5 s → HTML `aborted`, requisição do app `net::ERR_ABORTED`; tempo real: `timeoutMs: 2000` → `timeout` |
| 9 | `fetch()` direto no iframe | ✅ bloqueado | `fetch('https://api.github.com/zen')` rejeitado pela CSP com internet disponível |
| 10 | Build público sem backend | ✅ | `npm run test:static` (chromium): `aurora.request()` → `unavailable`, nenhuma chamada a `/api`; o pacote não contém `/api/` |

Outras observações reais: o httpbin ecoou `User-Agent: AuroraBoard-NetBridge/1 (+https://github.com/LeonardoSSm/aurora-board)` — o cabeçalho fixo do servidor, não o do navegador; nenhuma URL apareceu no painel (“Última consulta” mostra só o domínio).

**Não verificado:** Firefox/WebKit ao vivo (só Chromium; os demais motores são cobertos pela CI com transporte simulado); Linux (sem máquina Linux disponível nesta homologação).

**Problemas encontrados:** nenhum. Nenhuma correção foi necessária.
