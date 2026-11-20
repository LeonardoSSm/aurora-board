# Finanças pessoais — guia de uso e arquitetura (ciclo F1)

“Minhas contas” (botão na barra superior) é a gestão financeira pessoal do Aurora Board. Os dados ficam **só neste navegador**, num banco local separado dos quadros. O canvas consulta esses dados; ele não é onde eles moram.

## Uso rápido

1. **Minhas contas → Contas → Adicionar conta**: instituição, nome, tipo (corrente, poupança, pagamento, investimentos, cartão de crédito, outra), moeda, últimos 4 dígitos (opcional) e saldo inicial (opcional — ancora o saldo estimado). Cartões aceitam limite, dia de fechamento e de vencimento.
2. **Importar extrato** (CSV ou OFX exportado pelo banco): arquivo → conta → mapeamento (CSV) → prévia → **Confirmar importação**. Nada é gravado antes da confirmação. Ver [BANK_IMPORT.md](BANK_IMPORT.md).
3. **Visão geral**: receitas, despesas (consumo líquido), resultado, transferências, pagamentos de fatura, saldos por conta (informado × estimado × fluxo), consolidado, despesas por categoria e recorrências.
4. **Transações**: busca e filtros (conta, período, categoria, tipo, origem, status), edição do tipo e da categoria (classificação local), pares sugeridos de transferência/fatura, lançamentos manuais, exportação CSV.
5. **No quadro**: biblioteca → *Finanças visuais* → **Despesas do banco / Receitas do banco / Saldo das contas** (bloco `aurora.bank-query`). Conecte ao Mês, à Fórmula ou ao Gráfico com conexões de **Dados**.
6. **IA**: no painel do bloco de consulta, escolha *Resumo agregado* ou *Movimentações*, veja a prévia e autorize. Sem isso, nada vai para a IA. Ver [FINANCIAL_PRIVACY.md](FINANCIAL_PRIVACY.md).

## Arquitetura

```
Arquivo CSV/OFX ──┐                                  ┌─> Minhas contas (UI)
Provedor (fictício)┴─> normalização ─> planejador ─> razão local (IndexedDB aurora-finance)
                       (drafts)        (dedupe)       │
                                                      └─> consultas (query.ts) ─> fluxo de dados ─> Mês / Fórmula / Gráfico / IA
```

| Módulo | Papel |
|---|---|
| `src/finance/model.ts` | Entidades e invariantes (centavos com sinal da conta, datas `AAAA-MM-DD`, origem rastreável, classificação local separada do registro). |
| `src/finance/parsing.ts`, `csv.ts`, `ofx.ts` | Leitura estrita de valores/datas, CSV RFC 4180, OFX SGML/XML. |
| `src/finance/importPlan.ts` | Deduplicação e plano de importação (puro, sem gravar). |
| `src/finance/classify.ts`, `reconcile.ts` | Classificação inicial e conciliação de pares entre contas próprias. |
| `src/finance/reports.ts` | Fluxos, saldos, consolidado, cartões, recorrências. |
| `src/finance/repository.ts` | IndexedDB separado (`aurora-finance`) e adaptador em memória. Escritas compostas atômicas. |
| `src/finance/store.ts` | Estado em memória + operações do usuário. Grava no disco antes de mudar a memória. |
| `src/finance/query.ts`, `aiShare.ts` | Consulta do canvas e texto autorizado para IA. |
| `src/finance/backup.ts` | Backups financeiros (opcionalmente cifrados). |
| `src/finance/providers/` | Contrato `BankDataProvider`, provedor fictício e sincronização. |
| `src/ui/finance/` | Interface “Minhas contas”. |
| `src/widgets/builtin/bankQuery.tsx` | Bloco de consulta bancária no canvas. |

### Modelo

- **Instituição**: nome, código opcional, tipo, status, origem, referência opaca do provedor.
- **Conta**: tipo, moeda, número **mascarado** (`•••• 1234`), status, saldo informado (valor + data + origem), saldo inicial declarado, dados de cartão (limite, limite disponível, fechamento, vencimento).
- **Transação**: id local, conta, origem (`manual|csv|ofx|provider|backup` + importação + arquivo), ID externo (FITID/provedor), chave de deduplicação, data da operação e de contabilização, descrição, memo, centavos com sinal, moeda, direção, tipo informado pela fonte, status (`posted|pending`), referência, parcela, data da importação e **classificação local** (`local`: tipo de movimento, categoria, fonte da classificação, vínculo de par, nota).
- **Sessão de importação**: origem, arquivo/provedor, conta, contagens (lidas, aceitas, duplicadas, ignoradas, conflitos, inválidas, atualizadas), intervalo, saldo informado, avisos/erros, status (`committed|reverted`) e o que ela atualizou (para reverter).
- **Consentimento**: provedor, ambiente (`mock|sandbox|production`), referência opaca, escopos de leitura, status, datas. **Nunca** segredos.
- **Categorias** (16 padrão, editáveis) e **regras** locais (“descrição contém X” → categoria/tipo).

### Persistência

- Banco `aurora-finance` v1 (stores `meta`, `institutions`, `accounts`, `transactions`, `imports`, `consents`, `categories`, `rules`). O banco dos quadros (`aurora-board`) e `SCHEMA_VERSION` **não mudaram**.
- Índices: `byAccount`, `byAccountDate`, `byImport`, `byDedupe`.
- Importação, reversão, exclusão de conta, restauração e “apagar tudo” são transações únicas. Uma chave de deduplicação repetida na mesma conta aborta a gravação inteira (defesa em profundidade).
- Limites: 250 mil movimentações, 200 contas, 5 mil importações; acima disso a gravação é recusada inteira.
- Ao carregar, registros corrompidos ficam fora da memória (aviso na interface), sem apagar o disco.
- `FINANCE_SCHEMA_VERSION = 1`; migrações futuras serão aditivas no `upgrade` do IndexedDB.

### Exclusões

| Ação | Efeito | Não faz |
|---|---|---|
| Reverter importação | Remove o que ela criou; restaura pendentes que ela atualizou; desfaz pares órfãos | Não toca em outras importações nem em lançamentos manuais |
| Excluir dados locais da conta | Conta + movimentações + importações dela | Não altera nada na instituição |
| Revogar consentimento (Conectores) | Revoga no provedor | Não apaga dados locais |
| Excluir dados locais da conexão | Apaga as contas daquela conexão | Não revoga o consentimento |
| Apagar todos os dados financeiros | Zera o razão local (confirmação digitada “APAGAR”) | Não afeta quadros; não revoga autorizações externas |

## Limitações

Ver [F1-FINAL-REPORT.md](F1-FINAL-REPORT.md#n-pendências) e `docs/KNOWN_ISSUES.md`. Principais: sem conexão bancária real; armazenamento local não cifrado (só os backups podem ser); sem conversão de moedas; mês de fatura estimado pelo dia de fechamento.
