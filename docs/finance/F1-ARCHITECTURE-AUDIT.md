# Ciclo F1 — Auditoria inicial, baseline e proposta arquitetural

Data: 2026-11-19 · Base: `main@fe08795` (a referência do pedido, `d3cc08a`, é ancestral direta; `fe08795` só acrescenta ajustes das ações da IA) · Branch: `feature/personal-finance-hub-f1`.

## 1. Baseline (antes de qualquer alteração)

| Verificação | Comando | Resultado |
|---|---|---|
| Tipos | `npm run typecheck` | ✅ sem erros |
| Unitários | `npm test` | ✅ 24 arquivos, 509 testes |
| Build público | `npm run build` | ✅ |
| E2E Chromium | `npm run test:e2e` | ⚠ 64 passaram, 1 falhou (`acceptance.spec.ts › 19`, preexistente — ver §1.1) |
| Dependências | `npm run audit:prod` / `audit:full` | ✅ 0 vulnerabilidades |
| Firefox E2E | — | ❌ não executa nesta máquina Windows (binário bloqueado pelo SO; preexistente, documentado em `docs/KNOWN_ISSUES.md`). Coberto pela CI. |

### 1.1 Resultados complementares

Executados no mesmo commit, sem alterações:

- Build: ✅ (`tsc -b && vite build`, só o aviso de tamanho de chunk já existente).
- Auditorias: ✅ `audit:prod` e `audit:full` — `found 0 vulnerabilities`.
- E2E Chromium: 64 ✅ / 1 ❌ em 3,8 min. A falha é `acceptance.spec.ts › 19` (“bloco de IA sem credenciais aparece como não configurado”): o Playwright reaproveita o dev server local, que lê o `.env` com chaves reais e mostra a IA como configurada. Passa na CI (sem chaves). Preexistente.

Falhas preexistentes conhecidas (não introduzidas por este ciclo): Firefox local; teste 19 com `.env` real; intermitência de `security.test.ts`/`server-hardening.test.ts` em paralelo no Windows.

## 2. Arquitetura encontrada

- **Quadros**: `Board.elements: AuroraElement[]`, persistidos no IndexedDB `aurora-board` (v1, stores `workspaces`, `boardMeta`, `boards`, `assets`, `kv`). Esquema visual versionado por `SCHEMA_VERSION = 3` com `MIGRATIONS` por quadro.
- **Widgets**: registro em `src/widgets/registry.ts` (`WidgetPlugin` com `sanitize`, `compute`, `summarize`, portas). Os dados ficam em `element.data`, saneados a cada leitura.
- **Fluxo de dados** (`core/dataflow.ts` + memo em `widgets/dataflow.ts`): cálculo puro e síncrono sobre os elementos. O memo compara uma lista de *tokens* (ids, dados, portas). **Consequência importante**: um widget cujo resultado depende de algo fora do quadro (o razão bancário) não recalcula sozinho — é preciso um token externo de versão e invalidar o reaproveitamento de nós.
- **Finanças visuais**: `aurora.value` (MoneyValue em centavos, papel income/expense/neutral, chave estável), `aurora.finance-period` (mês; deduplica por chave), `aurora.formula` (decimal exato), `aurora.chart`, `aurora.finance` (lançamentos manuais dentro do widget). Dinheiro sempre em centavos inteiros; decimais em `bigint` com 8 casas.
- **IA**: o contexto é montado só de elementos ligados por conexões `context`/`data` e autorizados no bloco (`integrations/aiContext.ts`); o conteúdo é o `summarize` de cada widget. Ações v2 (`integrations/aiActions.ts`) exigem prévia e confirmação.
- **Exportação/importação**: `aurora-board` JSON com quadros + assets; orçamento de complexidade (S1) antes da validação; gravação atômica.
- **Segurança S1**: sandbox HTML isolado, CSP, build público sem `/api` nem `window.__aurora`, servidor só em loopback, importação endurecida.

## 3. Respostas às questões arquiteturais

1. **Separar registros bancários dos dados visuais** — módulo próprio `src/finance/` com banco IndexedDB **separado** (`aurora-finance`), sem tocar no banco/esquema dos quadros. Os widgets só guardam a *consulta* (filtros + referência ao razão local), nunca as transações.
2. **Instituições, contas e cartões** — `FinancialInstitution`, `FinancialAccount` (tipos `checking`, `savings`, `payment`, `investment`, `credit_card`, `other`). Cartão é uma conta `credit_card` com bloco `card` (limite, limite disponível, fechamento, vencimento). Limite disponível nunca é somado a saldo bancário.
3. **Armazenar transações** — store `transactions` com índices `byAccount`, `byAccountDate` (`[accountId, postedDate]`), `byImport` e `byDedupe` (`[accountId, dedupeKey]`). Um razão em memória (carregado sob demanda) atende consultas síncronas do canvas.
4. **Centavos** — `amountCents` inteiro seguro, **com sinal do ponto de vista da conta** (crédito +, débito −). Parsing monetário estrito por arquivo (separador decimal detectado ou escolhido), nunca `parseFloat`.
5. **Lançamentos manuais** — transações com `source.kind = 'manual'`; importações nunca as apagam ou sobrescrevem (a deduplicação só compara registros da mesma origem/conta e jamais altera manuais).
6. **Contar o mesmo valor duas vezes** — (a) importação: ID externo (FITID) ou impressão digital `data|valor|descrição normalizada` + índice de ocorrência no arquivo; (b) conciliação: transferências e pagamentos de fatura pareados e excluídos de receita/despesa; (c) canvas: chaves estáveis `bank:tx:<id>` nas ocorrências e `members` nos agregados; o Mês recusa sobreposição.
7. **Compartilhar com o motor financeiro** — novo widget `aurora.bank-query` (consulta bancária) que produz `money`, `finance.occurrences` e `finance.period`, tipos que os widgets existentes já aceitam. Contratos atuais preservados (campos novos opcionais).
8. **Dados sensíveis** — banco local separado; nada de extratos no JSON do quadro; números de conta mascarados (só últimos 4); IA só recebe o que foi configurado e confirmado no próprio widget; descrições tratadas como dados não confiáveis; sem logs de transações.
9. **Backups compatíveis** — formato de quadros inalterado. Novo formato `aurora-finance` (versionado, `FINANCE_SCHEMA_VERSION`), opcionalmente cifrado (AES-GCM 256 + PBKDF2-SHA-256 via Web Crypto). Backup pessoal completo é uma operação explícita.
10. **Conectores futuros** — contrato `BankDataProvider` (somente leitura) → normalização → mesmo planejador de importação/deduplicação → razão. Widgets não conhecem provedores.

## 4. Decisões e alternativas descartadas

| Decisão | Alternativa descartada | Motivo |
|---|---|---|
| Banco IndexedDB separado `aurora-finance` | Novas stores no `aurora-board` (DB v2) | Subir a versão do banco de quadros arrisca a migração dos dados existentes e mistura domínios; isolamento facilita apagar tudo e backups separados. |
| Sinal do valor relativo à conta | Valor sempre positivo + direção | Saldo da conta = soma direta; a direção (`credit`/`debit`) é derivada e gravada para auditoria. |
| Classificação em camada separada (`local`) | Editar a transação | Preserva o registro original do banco (requisito). |
| Parser OFX próprio (tokenizador SGML/XML) | `DOMParser`/bibliotecas XML | Sem entidades externas, sem rede, limites explícitos; funciona igual no navegador e em testes Node. Nenhuma dependência nova. |
| Cifra só nos **backups** | Cofre que cifra o IndexedDB inteiro | Consultas síncronas do canvas exigiriam a chave em memória o tempo todo e todo o índice cifrado; fazer isso mal daria falsa sensação de proteção. Documentado em `FINANCIAL_PRIVACY.md`. |
| Provedor fictício no app, rotulado | Sandbox externo | Pluggy/Belvo exigem credenciais de aplicação e backend; nenhuma credencial foi fornecida. |

## 5. Pesquisa Open Finance (resumo; detalhes em `OPEN_FINANCE.md`)

- Open Finance Brasil: os dados transacionais são consumidos por **instituições receptoras autorizadas pelo BC** (Res. Conjunta nº 1 e Res. BCB nº 32). Pessoa física não acessa as APIs diretamente; precisa de um participante ou intermediário.
- Pluggy: API com `clientId/clientSecret` → `apiKey` (2 h) gerada no servidor; *connect token* (30 min) para o widget; webhooks por item. Preços comerciais sob consulta; existe o “Meu Pluggy” para uso pessoal, cujas condições (gratuidade/trial) não puderam ser confirmadas em fonte oficial.
- Belvo: sandbox gratuito com “Mock Bank”; produção a partir de ~US$ 1.000/mês (fonte de terceiros).
- Conclusão: nenhuma conexão real é feita neste ciclo; a arquitetura fica pronta para um adaptador com backend.
