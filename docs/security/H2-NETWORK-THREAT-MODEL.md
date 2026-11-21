# Extensão H2 do modelo de ameaça — HTML Network Bridge

Complementa o [modelo de ameaça S1](S1-THREAT-MODEL.md) sem reescrevê-lo: o S1 descreve o estado auditado em 2026-11-19, quando o HTML dos widgets **não tinha rede**. O ciclo H2 (issue #30) introduz uma saída controlada para a internet. Detalhes de uso e do protocolo: [docs/HTML_NETWORK_BRIDGE.md](../HTML_NETWORK_BRIDGE.md).

## O que muda

Antes: o iframe isolado (`sandbox="allow-scripts"`, origem opaca, CSP `default-src 'none'`) não conseguia enviar nada para fora; os dados que ele recebia pela ponte H1 (inclusive bancários) só podiam sair por IA autorizada.

Agora: o iframe pode **pedir** ao host uma consulta GET. O iframe continua sem rede própria — a CSP do documento isolado é a mesma (testada contra três cópias) e o `fetch` direto continua bloqueado. A saída passa por duas camadas confiáveis: o host (origem do app) e o servidor local.

```
 iframe (não confiável, sem rede)
   │ aurora:request {token,id,url}
   ▼
 host — origem do app (React/store/IndexedDB)
   ├─ confere janela de origem + token da montagem, limites por iframe
   ├─ autorização LOCAL do usuário (htmlNetGrants, fora de quadros/backups)
   ├─ política de dados sensíveis (fontes protegidas → autorização adicional específica)
   └─ POST /api/net/fetch ───────────────▶ servidor local 127.0.0.1 (só o computador principal)
                                              ├─ HTTPS/443, sem IP literal/nomes locais
                                              ├─ DNS na conexão, todos os IPs + IP do socket conferidos
                                              ├─ sem redirecionamentos, sem cabeçalhos do navegador
                                              └─ tempo/tamanho/tipos/limites ──▶ API pública
```

## Ativos novos ou reavaliados

| Ativo | Risco novo |
|---|---|
| Dados bancários, Meu Pluggy, Data Hub, finanças | Exfiltração por URL (caminho/consulta) de um GET autorizado |
| Rede interna do usuário e metadados de nuvem | SSRF pelo servidor local a partir do HTML |
| IP/identidade de rede do usuário | Rastreamento por consultas feitas sem o usuário saber |
| Cota/credibilidade em APIs públicas | Abuso (laços de consultas) a partir do computador do usuário |

## Ameaças e controles

| Ameaça | Controle | Onde é verificado |
|---|---|---|
| HTML importado consulta a rede ao abrir | HTML importado/colado começa desativado (S1); sem autorização, nada sai; a autorização nunca vem do arquivo; marca de ativação nova a cada importação invalida autorizações antigas | host · `tests/unit/net-bridge.test.ts` (backups) |
| Permissão forjada no quadro, no estado ou no backup | Não existe campo que a leia: autorizações só em `htmlNetGrants` (kv local); exportação não as inclui | host · unit + E2E A |
| Exfiltração de dados protegidos por URL | Fontes protegidas (e derivados, inclusive via Assistente IA, estado gravado, memória da execução e HTML a montante) exigem autorização **adicional** que lista fontes e destino; fonte não verificável bloqueia | host · unit (sensível, marca, montante, IA) |
| Autorização de IA reaproveitada para rede | Chaves e armazenamentos separados; teste com autorizações de IA presentes e rede negada | host · unit |
| Consentimento “cansado” (janelas em série) | Pedidos simultâneos coalescidos; “Negar” vale para a execução; uma janela por vez | host · unit + E2E |
| Iframe forja mensagens de outro bloco / reaproveita resposta | `event.source` + token por montagem + ids únicos; resposta só ao id pendente | host · unit + E2E C |
| SSRF: IP privado, loopback, link-local, metadados | Host recusa IP literal e nomes locais; servidor resolve DNS na conexão e recusa se QUALQUER endereço for proibido; confere o IP do socket | servidor · `tests/unit/net-server.test.ts` |
| DNS rebinding | Resolução dentro da conexão, sem pool; cada consulta valida de novo | servidor · unit |
| IPv4 mapeado/compatível, NAT64, 6to4, Teredo | Lista de bloqueio ampliada (`::/96`, `64:ff9b::/96`, `64:ff9b:1::/48`, `2002::/16`, `2001::/23`…) | servidor · unit (23 endereços) |
| Redirecionamento para destino interno ou não autorizado | Redirecionamentos não são seguidos na v1 | servidor · unit |
| Cookies/Authorization/token de pareado vazando para terceiros | Servidor envia só três cabeçalhos fixos; corpo da rota com chaves exatas | servidor · unit |
| Respostas gigantes, binárias, comprimidas, JSON profundo | 1 MB, sem compressão, só JSON/texto UTF-8, 64 níveis | servidor + host · unit |
| Laços de consulta / abuso | 8 pendentes e 30/min por iframe; 4 simultâneas no host; 120/min, 6 simultâneas e 60/min por domínio no servidor | host + servidor · unit |
| Dispositivo pareado usando a rede do computador principal | `/api/net/*` recusa chamadas remotas (`local_only`), mesmo com token válido | servidor · unit |
| Chamada direta da rota pelo iframe ou por um site | `Origin: null`/externa e `Host` não local → 403; o iframe nem tem `connect-src` | servidor · unit + E2E |
| Build público expondo a rota | `LOCAL_API_ENABLED` elimina o transporte do pacote; `aurora.request()` → `unavailable` | build · E2E static |
| Revogação que não para consultas em andamento | Revogar remove concessões e cancela pendentes; toda resposta é revalidada antes de chegar ao HTML | host · unit |

## Garantias por camada

- **Dependem do host local (app):** autorização do usuário, política de dados sensíveis, limites por iframe, cancelamento por desmontagem/edição/revogação. O servidor não tem como saber quem autorizou o quê: as autorizações moram no IndexedDB da origem do app, junto com os dados que protegem. Um app adulterado (extensão maliciosa, código modificado) já teria acesso direto aos dados — fora do modelo, como no S1.
- **Verificadas pelo backend sozinho:** tudo o que é rede — esquema, porta, destino público, DNS, IP conectado, redirecionamentos, cabeçalhos, tamanho, tempo, tipos, limites, chamador local e não pareado.

## Riscos residuais (aceitos e documentados)

- **Canal de exfiltração por URL após consentimento.** Com a autorização específica, o HTML pode codificar dados derivados das fontes no caminho/consulta do GET. É exatamente o que o usuário autorizou, mas ele pode não perceber. A janela diz isso explicitamente.
- **Canal lateral por tempo/frequência** de consultas autorizadas a um destino controlado pelo autor do HTML (mesmo sem dados protegidos). Mitigado só por limites de frequência.
- **Destino confiável comprometido.** A autorização é por origem; o conteúdo da resposta não é confiável e só alimenta o HTML isolado (nada executa no app).
- **Identidade de rede.** O IP do computador principal é exposto às APIs autorizadas.

## Gravidade (escala S1)

Nenhum achado P0/P1 aberto ao fim do H2. Os apontamentos das revisões do Codex estão registrados nos PRs do ciclo (#31, #32, #33) e foram corrigidos com testes de regressão.
