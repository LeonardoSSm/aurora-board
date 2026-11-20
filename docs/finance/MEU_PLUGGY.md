# Meu Pluggy — integração pessoal, somente leitura (issue #9)

> **Estado (2026-11-20):** implementado e testado só com uma Pluggy **simulada** (testes unitários e E2E offline). **Nenhuma conta real foi conectada.** Isso só acontece no seu computador, depois que você autorizar os bancos no Meu Pluggy e preencher o `.env` local.

## O que é

O [uso pessoal do Meu Pluggy](https://docs.pluggy.ai/pt/docs/guides/meu-pluggy-personal-use) é **gratuito**, exclusivo para uso pessoal (sem uso comercial) e permite até **5 conexões**. Você conecta seus bancos no portal [meu.pluggy.ai](https://meu.pluggy.ai/) e depois autoriza o conector **MeuPluggy** na sua aplicação do [Dashboard da Pluggy](https://dashboard.pluggy.ai/). O servidor local do Aurora usa as credenciais dessa aplicação para **ler** contas, saldos e movimentações já disponíveis.

Limites e regras da Pluggy (documentação oficial consultada em 2026-11-19):

- O Meu Pluggy atualiza os dados automaticamente **cerca de uma vez a cada 24 h**. Não é possível forçar uma atualização, e o Aurora não tenta. “Sincronizar” lê o que já está disponível na Pluggy.
- A autorização da aplicação vale **1 ano**, separada do consentimento de cada banco. Depois de expirar, a Pluggy devolve listas **vazias**. Por isso o Aurora confere o estado do item antes de ler e mostra “Consentimento expirado”.
- Ao renovar a autorização, o **itemId pode mudar**.
- `GET /v2/items` não existe para o Meu Pluggy: os itemIds são copiados do Dashboard.
- O endpoint legado `GET /transactions` não é usado. Ele responde 410 para aplicações criadas depois de 02/06/2026 e será encerrado em 31/12/2026. O Aurora usa `GET /v2/transactions`, que pagina por cursor.
- Somente leitura: o Aurora não tem nenhuma operação de pagamento, Pix, transferência, investimento ou escrita na Pluggy.

## Passo a passo no seu computador

Nenhum segredo precisa passar pelo chat, pelo Git ou por uma issue. Tudo fica no arquivo `.env`, que o Git ignora.

1. **Conecte os bancos no Meu Pluggy.** Entre em [meu.pluggy.ai](https://meu.pluggy.ai/) e conecte suas contas (por exemplo, Inter e Nubank). A autorização de cada banco é feita ali, no fluxo do próprio banco. O Aurora nunca pede senha, token ou código de banco.
2. **Autorize o conector MeuPluggy na sua aplicação.** No [Dashboard da Pluggy](https://dashboard.pluggy.ai/), abra **Aplicações → Demo → Conectar conta**, escolha **MeuPluggy** (não o banco, nem Sandbox) e autorize as contas que quer compartilhar.
3. **Copie três informações do Dashboard:**
   - **Client ID** e **Client Secret** da aplicação;
   - o **itemId** de cada item conectado. Ele aparece na lista de itens conectados da aplicação (Demo). É um UUID, como `aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`.
4. **Preencha o `.env`.** Ele fica na pasta do Aurora Board, ao lado do `package.json`. Se não existir, copie `.env.example` para `.env`. Edite no seu editor e adicione:

   ```dotenv
   PLUGGY_CLIENT_ID=<seu Client ID>
   PLUGGY_CLIENT_SECRET=<seu Client Secret>
   PLUGGY_ITEM_IDS=<itemId 1>,<itemId 2>
   ```

   Não coloque aspas nem espaços em volta do `=`. Para conferir que o `.env` está fora do Git, rode `git check-ignore .env`: ele deve imprimir `.env`.
5. **Reinicie o servidor local:** pare o `npm run dev` (ou o `npm run dev:lan`) e rode de novo. No terminal deve aparecer a linha `[aurora-api] Meu Pluggy: configurado (N item(ns), somente leitura)`. Se aparecer “configuração incompleta”, a linha diz o que falta, sem mostrar valores.
6. **No Aurora:** abra **Minhas contas → Conectores → Meu Pluggy** e clique em **Verificar Meu Pluggy**. Cada item aparece com o estado da autorização e a data de validade.
7. **Adicione o item:** clique em **Adicionar ao Aurora**.
8. **Faça a prévia antes de gravar.** Escolha o período (3, 6 ou 12 meses) e clique em **Prévia**. Nada é gravado nessa etapa. Para cada conta da Pluggy:
   - **Criar conta nova** (padrão); ou
   - **Vincular** a uma conta que você já tem no Aurora (importada de CSV/OFX ou manual) do mesmo tipo. O vínculo começa no dia seguinte à última movimentação vinda de arquivo, para o histórico não ser duplicado.
   - **Confira um saldo e duas ou três movimentações com o app do banco** (valor, sinal e data). A primeira sincronização real é a validação final da conversão. Se algo vier errado, não sincronize e registre uma issue sem dados reais.
9. **Sincronize:** clique em **Sincronizar dados já disponíveis**. Repetir a sincronização não duplica nada.

Pareamento com outro PC da rede: por padrão, o Meu Pluggy **só responde no computador principal**. Se quiser que um computador pareado também leia os dados (ele fica com uma cópia própria no navegador dele), adicione `AURORA_PLUGGY_PAIRED_READ=1` ao `.env` e reinicie.

### Renovação, expiração e erros

| Situação | O que o Aurora mostra | O que fazer |
|---|---|---|
| Autorização expirada (1 ano) | “Consentimento expirado” e a mensagem da Pluggy | Renove em meu.pluggy.ai / Dashboard. Se o itemId mudar, troque-o em `PLUGGY_ITEM_IDS`, reinicie, adicione o item novo e sincronize. As contas são reconhecidas pelo tipo, instituição e final do número, e o histórico não é duplicado. Depois, use “Esquecer conexão” no item antigo (os dados ficam). |
| Item fora de `PLUGGY_ITEM_IDS` | Aviso no item antigo | O mesmo da linha acima |
| `LOGIN_ERROR` | Mensagem pedindo refazer a conexão no Meu Pluggy | Refaça a conexão no portal |
| `OUTDATED` | Ativo, com aviso de dados possivelmente desatualizados | Aguarde a próxima atualização automática |
| Credenciais recusadas | “A Pluggy recusou PLUGGY_CLIENT_ID/PLUGGY_CLIENT_SECRET…” | Confira o `.env` (sem colar segredos no chat) |
| Limite de requisições (429) | “Falha temporária” e o tempo de espera | Tente depois do tempo indicado |
| Pluggy fora do ar ou sem rede | “Falha temporária” | Tente de novo; nada local é apagado |

Revogar: a autorização é gerenciada **no Meu Pluggy**. No Aurora, “Esquecer conexão” remove só o registro local, e “Excluir dados locais” apaga as contas daquela conexão neste navegador. As duas ações são separadas, e nenhuma delas altera nada na Pluggy.

## Arquitetura

```
navegador ──/api/pluggy/*──▶ servidor local 127.0.0.1 (server/app.ts) ──HTTPS──▶ https://api.pluggy.ai
   │ PluggyPersonalProvider            │ PluggyClient (server/pluggy.ts)
   │ (src/finance/providers/pluggy.ts) │ credenciais do .env, API Key em memória
   ▼
sync.ts → planImport (deduplicação F1) → razão aurora-finance (IndexedDB) → relatórios → canvas
```

### Servidor local (`server/pluggy.ts`)

- **Credenciais:** `PLUGGY_CLIENT_ID`, `PLUGGY_CLIENT_SECRET` e `PLUGGY_ITEM_IDS` vêm só do ambiente (`.env`). A validação descreve o problema sem ecoar valores. A API Key (válida por 2 h) é obtida sob demanda, fica só na memória e é renovada antes de 100 min ou depois de um 401 (uma vez). Ela vai só no cabeçalho `X-API-KEY`, nunca numa URL.
- **Destino fixo:** `https://api.pluggy.ai`, com TLS e `redirect: 'error'`. Toda URL é montada no servidor e tem a origem conferida antes de cada chamada. O cursor `next` só é aceito como query string relativa, e só o valor de `after` é reaproveitado. Um `next` com esquema, host ou caminho é recusado.
- **Endpoints da Pluggy:** `POST /auth`, `GET /items/{id}`, `GET /accounts?itemId&page&pageSize`, `GET /v2/transactions?accountId&dateFrom&dateTo&after`. Vão só parâmetros documentados, porque a Pluggy passa a recusar parâmetros desconhecidos em 23/11/2026.
- **Limites:** tempo máximo de 20 s por chamada; resposta de até 8 MB; até 200 páginas e 100 mil movimentações por pedido; intervalo de até ~3 anos; no máximo 120 chamadas de saída por minuto (a Pluggy limita ~360/min por endpoint); uma nova tentativa em 5xx ou falha de rede. Fechar a conexão no navegador cancela a chamada à Pluggy.
- **Erros:** 401 → `auth_failed`, 403 → `forbidden`, 404 → `not_found`, 410 → `deprecated`, 429 → `rate_limited` (com `Retry-After` repassado ao navegador), 5xx/rede → `unavailable`, formato inesperado → `bad_response`, tetos → `too_large`. As mensagens não ecoam o corpo da Pluggy; os logs guardam só o código (`codeDescription`).
- **Validação em tempo de execução** (zod) de item, conta, página e movimentação. Um registro fora do formato é descartado e contado como `invalid`.
- **Dados que nunca saem do servidor:** `paymentData` (CPF/CNPJ de pagador e recebedor), `taxNumber`, `owner`, número completo da conta ou do cartão (vão só os 4 últimos caracteres) e `merchant`.

### Rotas internas (só GET, só leitura)

| Rota | Resposta |
|---|---|
| `GET /api/pluggy/status` | `{ configured:false, problems[] }` ou `{ configured:true, readOnly:true, items:[{ itemId, connectorName, status, consentStatus, consentExpiresAt, lastUpdatedAt, nextAutoSyncAt, message }] }` |
| `GET /api/pluggy/accounts?itemId` | contas normalizadas (`id, itemId, name, type, currency, numberTail, institutionName, balance, card`) |
| `GET /api/pluggy/transactions?itemId&accountId&from&to` | `{ transactions, invalid, pages }` |

Proteções S1 mantidas: só conexões de loopback, Host e Origin locais, limite por rota (60/min, 2 simultâneas), e só GET (outros métodos → 405). O `itemId` precisa estar em `PLUGGY_ITEM_IDS`, e o `accountId` precisa pertencer ao item. Para chamadas de dispositivos pareados, a resposta é **403 `local_only`**, salvo `AURORA_PLUGGY_PAIRED_READ=1`; sem token de pareamento válido, nem isso é avaliado.

### Conversão (decisões)

- **Valores:** a Pluggy informa números decimais em reais. A conversão para centavos inteiros é feita **por texto** (`toFixed(2)`), sem erro de ponto flutuante.
- **Sinal:**
  - Cartão: compra positiva na Pluggy (documentado) vira **negativa** no razão, e pagamento ou estorno vira positivo.
  - Conta: `DEBIT` é saída e `CREDIT` é entrada. Se o sinal do valor contradiz `type`, prevalece `type`, porque há conectores que mandam o valor absoluto. A documentação só mostra isso em exemplos, então confira na primeira prévia.
- **Saldo do cartão:** a fatura em aberto (positiva na Pluggy) vira saldo negativo, que é dívida. O limite total e o disponível vão para `card` e nunca somam a saldos bancários.
- **Datas:** meia-noite UTC exata (`…T00:00:00.000Z`) é tratada como data civil. Com hora, a data é convertida para o horário de Brasília (UTC−3).
- **Status:** `PENDING` → pendente e `POSTED` → contabilizada. Uma pendente que volta contabilizada com o mesmo id atualiza o registro existente (fluxo F1).
- **Instituição:** o conector MeuPluggy agrega vários bancos num item. A instituição sai do código COMPE do `transferNumber` (077 Inter, 260 Nubank etc.) ou do nome da conta; sem isso, fica “Meu Pluggy”.
- **Parcelas e data da compra** vêm de `creditCardMetadata`.
- **Moeda:** só BRL, USD e EUR. Uma movimentação em moeda diferente da conta usa `amountInAccountCurrency`; sem esse campo, é descartada.

### Deduplicação e conciliação (reuso do F1)

- Tudo passa por `planImport`. A identidade é `ext:<id da Pluggy>`, então reimportar não duplica.
- **Conta vinculada a extrato existente:** `providerRef.since` faz a Pluggy só contribuir a partir do dia seguinte ao último lançamento vindo de arquivo, e a prévia mostra quantas ficaram “antes do vínculo”.
- **Sem vínculo:** uma movimentação com mesma data, valor e descrição de outra fonte vira *possível duplicidade* e fica de fora. Mesmo valor com data próxima e descrição diferente entra com alerta, e a prévia conta esses casos.
- **Renovação com itemId novo:** a conta é reconhecida pelo mesmo provedor, tipo, moeda, instituição e final do número, com candidato único, e o vínculo é atualizado. As movimentações com ids novos e conteúdo igual viram possíveis duplicidades e ficam de fora. Nada é apagado.
- A classificação manual (`local`) nunca é sobrescrita. Transferências e pagamentos de fatura são pareados pela conciliação automática conservadora do F1.

### IA

Nada muda: dados vindos da Pluggy são dados do razão como quaisquer outros, e só chegam a uma IA por um bloco “Consulta bancária” com **autorização local explícita** daquele bloco (`aiGrants`). Nada é enviado por padrão.

## Testes

- `tests/unit/pluggy-server.test.ts` (24): configuração; conversão de valores, datas, sinais, contas, item e cursor; cliente HTTP contra uma Pluggy falsa (autenticação e renovação, paginação, só `api.pluggy.ai`, só parâmetros documentados, 401/404/410/429/5xx, rede, tetos, cancelamento); rotas (não configurado, sem segredos nem dados de terceiros nas respostas e nos logs, item de fora → 404 sem chamada, 405, Host/Origin, pareado bloqueado ou liberado).
- `tests/unit/finance-pluggy.test.ts` (9): sincronização no razão (idempotente, instituição, saldos, cartão, conciliação), pendente → contabilizada, classificação manual preservada, prévia sem gravação, vínculo com CSV, possível duplicidade entre fontes, renovação com itemId novo, expiração sem leitura, 429, servidor ausente, respostas malformadas.
- `e2e/pluggy.spec.ts` (3, offline com `page.route`): não configurado; adicionar, prévia, vincular conta CSV e sincronizar sem duplicar (sem nenhuma requisição do navegador a `pluggy.ai`); 429 e expiração sem apagar dados.
- `e2e/static/public-build.spec.ts`: no build público, o cartão Meu Pluggy só explica que é indisponível e não chama `/api`.

Nenhum teste usa credenciais ou dados reais. O CI não recebe segredos da Pluggy.
