# Open Finance — arquitetura de conectores e estado real

> **Estado em 2026-11-20 (issue #9):** existem dois provedores. O **Meu Pluggy** (uso pessoal, gratuito, somente leitura) está implementado e testado só contra uma Pluggy simulada. **Nenhuma conta real foi conectada**: isso depende de o titular autorizar os bancos no portal e preencher o `.env` local (ver [MEU_PLUGGY.md](MEU_PLUGGY.md)). O **fictício** (ambiente de testes) continua sempre rotulado “DADOS FICTÍCIOS — AMBIENTE DE TESTES”.

## Pesquisa (fontes consultadas em 2026-11-19)

| Tema | O que foi apurado | Confiança |
|---|---|---|
| Quem acessa dados transacionais no Open Finance Brasil | APIs de dados cadastrais e transacionais são consumidas pela **instituição receptora**, participante autorizada pelo Banco Central; a transmissora compartilha mediante consentimento do cliente (Res. Conjunta nº 1/2020; Res. BCB nº 32/2020 e alterações, ex.: Res. BCB 294/2023). Pessoa física não consome as APIs diretamente | Alta (normativos do BCB) |
| Modelo de parceria | Receptoras autorizadas repassam dados a parceiros não participantes; uma alteração da Res. Conjunta nº 1 publicada em out/2026 trata desse modelo. O texto completo **não foi verificado** | Média — conferir antes de contratar |
| APIs públicas | “Dados abertos” (produtos, tarifas, canais) **não** dão acesso a transações pessoais | Alta |
| Pluggy | API REST; `clientId`/`clientSecret` trocados por `apiKey` (2 h) em `POST /auth` — **só no servidor**; *connect token* (30 min) para o widget de conexão; `webhookUrl` por item; ambiente de testes por conectores *sandbox* no mesmo host. Preços comerciais: “fale com vendas”. **Correção (2026-11-19, documentação oficial):** o [uso pessoal do Meu Pluggy](https://docs.pluggy.ai/pt/docs/guides/meu-pluggy-personal-use) é **gratuito**, não depende do trial comercial nem de due diligence, permite até 5 conexões, só para uso pessoal (sem uso comercial), com atualização ~a cada 24 h, sem atualização forçada e autorização da aplicação por 1 ano | Alta (documentação oficial) |
| Belvo | Sandbox gratuito com “Mock Bank” do Open Finance Brasil; produção a partir de ~US$ 1.000/mês no plano Launch (fonte de terceiros; página de preços instável em 2026) | Média |
| Custo para um único usuário | Intermediários comerciais custam na casa de milhares de reais por mês (relatos públicos). Para **uso pessoal**, o Meu Pluggy é gratuito (acima) — é o caminho implementado | Alta (Meu Pluggy) / média (demais) |

Fontes: [Resolução Conjunta nº 1 (BCB)](https://normativos.bcb.gov.br/Lists/Normativos/Attachments/51028/Res_Conj_0001_v9_L.pdf), [Pluggy — autenticação](https://docs.pluggy.ai/docs/authentication), [Pluggy — connect token](https://docs.pluggy.ai/reference/connect-token-create), [Pluggy — conceitos (v2)](https://v2.docs.pluggy.ai/en/docs/reference/basic-concepts.md), [Actual Budget — Pluggy](https://actualbudget.org/docs/advanced/bank-sync/pluggyai), [Belvo — planos](https://belvo.com/plans-and-pricing/), [Belvo — consentimentos](https://developers.belvo.com/apis/belvoopenapispec/consents), [comparativo Belvo × Pluggy](https://openbankingtracker.com/api-aggregators/belvo/vs/pluggy), [relato de custos (TabNews)](https://www.tabnews.com.br/GuilhermeVieira/estou-desenvolvendo-um-app-de-financas-pessoais-e-nao-consigo-pagar-o-open-finance-pluggy-r2-5k-mes-belvo-r6k-mes-tecnospeed-r1-5k-de-entrada-r540).

Não foram verificados neste ciclo: limites de taxa, política de retenção de cada intermediário, prazos de renovação de consentimento por instituição e cobertura atual por banco. Esses itens precisam ser lidos nos contratos/documentação no momento da contratação.

## Contrato `BankDataProvider` (somente leitura)

`src/finance/providers/types.ts`:

| Método | Função |
|---|---|
| `listInstitutions()` | Instituições disponíveis no provedor |
| `startConsent(institutionId, scopes)` | Inicia a jornada de consentimento; devolve `consentRef` opaco (e, num provedor real, a URL da jornada na instituição) |
| `getConsentStatus(consentRef)` | `awaiting`, `active`, `expired`, `revoked`, `error` |
| `listAccounts(consentRef)` | Contas e cartões (número é mascarado pela sincronização) |
| `getBalances(consentRef)` | Saldos informados (fotografia com data) |
| `listTransactions(consentRef, accountId, range)` | Movimentações com sinal da conta, status pendente/contabilizada |
| `refresh(consentRef)` | Pede dados novos ao provedor |
| `revokeConsent(consentRef)` | Revoga na origem (não apaga dados locais) |

Não existe — por desenho — nenhum método de pagamento, Pix, transferência ou escrita. Escopos usados: `accounts`, `balances`, `transactions`, `credit-cards-accounts`.

Fluxo: **Provider → normalização (`sync.ts`) → planejador de importação (mesma deduplicação dos arquivos) → razão → consultas → canvas**. Widgets não conhecem provedores. Dados do provedor passam pela mesma validação de arquivos (datas, centavos, textos).

Estados exibidos: não conectado, aguardando consentimento, conectado, sincronizando, atualizado, consentimento expirado, consentimento revogado, falha temporária, provedor indisponível. Erros do provedor viram estado; nada local é apagado.

## Provedor fictício

`src/finance/providers/mock.ts` — duas instituições (Banco Fictício Alfa e Beta), duas contas correntes, um cartão, salário, aluguel, TED entre as instituições, compras no cartão (inclusive parcelada), pagamento de fatura, estorno, tarifa, compra **pendente** que é liquidada após “Atualizar na instituição” (mesmo id), entrega **duplicada** de uma transação, consentimento com expiração (90 dias), expiração e falhas simuladas, revogação. Ative em *Minhas contas → Conectores → Ativar ambiente de testes*. O estado do consentimento fictício vive só na memória da aba: depois de recarregar, aparece como expirado (exercita a reconexão).

## Meu Pluggy (uso pessoal) — implementado

Caminho real e gratuito para o próprio titular: os bancos são autorizados no portal [meu.pluggy.ai](https://meu.pluggy.ai/) e no Dashboard (conector **MeuPluggy**); o **servidor local** guarda `clientId/clientSecret` no `.env`, obtém a API Key e lê, só para leitura, item, contas e `GET /v2/transactions` (cursor). O frontend usa o provedor `pluggy-personal`, que só conversa com `/api/pluggy/*`. Webhooks não são usados: o servidor local não é exposto à internet, e a sincronização é manual, sob demanda. Configuração, arquitetura, decisões e testes estão em **[MEU_PLUGGY.md](MEU_PLUGGY.md)**.

Diferenças em relação ao contrato genérico: o consentimento é dado no portal (`startConsent` só registra um item que já existe); `refresh` não força nada; `revokeConsent` não existe (gerencie no portal).

## Caminho para outros provedores (uso comercial / multiusuário)

1. **Escolha e contrato** de um intermediário. Nenhum cadastro pago foi feito.
2. **Backend seguro** (não o servidor local atual exposto): guarda `clientId/clientSecret`, gera `apiKey`/*connect token*, recebe webhooks, aplica autenticação do usuário, CSRF, limites, auditoria e retenção mínima. Tokens **nunca** no `localStorage` ou nos quadros.
3. **Adaptador** que implemente `BankDataProvider` falando só com esse backend (o frontend vê só `consentRef` e dados autorizados).
4. Jornada de consentimento na instituição (redirecionamento), renovação antes da expiração, revogação dos dois lados.
5. Testes no sandbox oficial do intermediário com dados fictícios; só depois, consentimento real **com autorização explícita do titular**.
6. Revisão de segurança específica (P0/P1 zerados) antes de usar com dados reais.

Credenciais que serão necessárias: `clientId` e `clientSecret` do intermediário (no backend), URL de webhook pública com segredo de verificação, e o consentimento do titular feito na instituição. Dados obtíveis (escopos de leitura): cadastro, contas, saldos, transações, cartões (limites, faturas, transações), conforme a cobertura de cada instituição.

**Conclusão (revisada em 2026-11-20)**: para o próprio titular existe um caminho gratuito e legítimo, o **Meu Pluggy** (uso pessoal, até 5 conexões, sujeito aos termos e limites da Pluggy), implementado em modo somente leitura. A importação de CSV/OFX continua disponível e é o caminho para bancos fora do Meu Pluggy. Uso comercial ou multiusuário continua exigindo contrato e um backend com autenticação.
