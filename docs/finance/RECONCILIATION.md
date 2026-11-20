# Conciliação, deduplicação e integridade contábil

## Identidade de uma movimentação (deduplicação)

Dentro de cada conta, toda movimentação tem uma `dedupeKey`:

- **Com ID da fonte** (FITID do OFX, id do provedor, coluna “ID” do CSV): `ext:<id>`.
- **Sem ID**: `fp:<data>|<centavos>|<descrição normalizada>#<n>`, onde `n` é a ocorrência dessa impressão digital **no arquivo**.

Consequências:

| Situação | Resultado |
|---|---|
| Mesmo arquivo importado de novo | Todas as chaves já existem → “Já importada”; nada entra |
| Arquivos com período sobreposto | As ocorrências já vistas casam; só as novas entram |
| Duas compras legítimas iguais no mesmo dia | `#1` e `#2`: as duas entram |
| Mesmo valor e data, descrição diferente | Entra, com alerta “possível duplicidade” — **valor + data nunca excluem sozinhos** |
| Mesma data, valor e descrição vindos de outro esquema (ex.: já importado por OFX, agora CSV) | “Possível duplicidade”, **desmarcada** para revisão |
| Mesmo ID com valor/data diferentes | “Conflito”, desmarcado; o registro gravado não é sobrescrito |
| Mesmo ID repetido no próprio arquivo | O segundo é ignorado |
| Pendente que chega contabilizada (mesmo ID, ou mesma descrição/valor em até 5 dias) | O registro existente é **atualizado** (status e data), sem duplicar; a reversão restaura |
| Moeda da linha diferente da conta | Linha inválida (sem conversão) |
| Lançamento manual | Nunca é comparado, alterado nem apagado por importações |

Defesa em profundidade: o repositório recusa (e aborta a transação inteira) qualquer gravação que repita `(conta, dedupeKey)`.

## Tipos de movimento

`income` (receita externa), `expense` (despesa de consumo), `transfer` (entre contas próprias), `card_payment` (pagamento de fatura, nos dois lados), `refund` (estorno), `reimbursement` (reembolso), `investment` (aplicação/resgate), `fee` (tarifa), `interest` (juros), `unclassified`.

Classificação inicial (camada local; o registro do banco não muda), na ordem:

1. Regra do usuário (primeira que casa).
2. Pagamento de fatura por texto (`PAGAMENTO FATURA`, `PAGTO CARTAO`, `PAGAMENTO RECEBIDO`…) com o sinal coerente com o tipo de conta.
3. Palavras-chave conservadoras: estorno, tarifa/anuidade/IOF, juros/rendimento, aplicação/resgate, reembolso.
4. Tipo informado pela fonte (`FEE`, `SRVCHG`, `INT`, `DIV`).
5. Sinal: conta → crédito = receita, débito = despesa; cartão → débito = compra; **crédito sem pista no cartão fica “não classificado”** (não adivinha).

O que o usuário classifica à mão (`kindSource/categorySource = user`) nunca é sobrescrito por regras ou pela conciliação automática.

## Transferências e pagamentos de fatura

Par = débito numa conta própria + crédito do **mesmo valor** em outra conta própria, mesma moeda, até 3 dias (transferência) ou 7 dias (pagamento de fatura, por compensação). Se uma das contas é cartão, o par é `card_payment`.

- Aplicado automaticamente **só** se for o único candidato à menor distância **e** houver evidência no texto (TED/PIX/DOC/transferência, ou pagamento de fatura) em pelo menos um lado.
- Caso contrário aparece em Transações → “Possíveis transferências”, para confirmar.
- Pares podem ser desfeitos (link “par” na linha). Mudar o tipo de uma ponta desfaz o par.
- Uma TED/PIX sem contrapartida importada continua despesa/receita: pode ser pagamento a terceiros.

## Regras do resultado

- **Receita externa** = `income` (+ reembolsos e juros recebidos, mostrados à parte).
- **Despesa de consumo líquida** = `expense` − estornos. Tarifas e juros pagos aparecem separados e entram no total de despesas.
- **Fora do resultado**: transferências entre contas próprias, pagamentos de fatura (nos dois lados) e aplicações/resgates.
- Cartão: compras = consumo; estorno reduz; pagamento da fatura não conta de novo. Se há pagamentos de fatura mas o cartão não foi importado, a visão geral avisa que o consumo pode estar subestimado.
- Pendentes entram nos totais e são sinalizadas.

### Exemplo obrigatório (teste `finance-ledger.test.ts` e E2E jornada D)

| Operação | Conta | Tipo |
|---|---|---|
| Salário +2.000,00 | A | receita |
| TED −500,00 / +500,00 | A → B | transferência (par) |
| Compra −300,00 | Cartão | despesa |
| Pagamento −300,00 / +300,00 | A → Cartão | pagamento de fatura (par) |
| Estorno +50,00 | Cartão | estorno |

Resultado: receita externa **R$ 2.000,00**; despesa de consumo líquida **R$ 250,00**; a transferência não aumenta a receita; o pagamento da fatura não gera segunda despesa. Saldos (com saldo inicial de A = 1.000,00): A = 2.200,00; B = 500,00; cartão = +50,00 (crédito); consolidado = 2.750,00. O limite do cartão nunca entra.

## Saldos

| Conceito | Definição |
|---|---|
| Saldo informado | Fotografia da fonte (OFX `LEDGERBAL`, provedor, ou digitado em “Informar saldo”), com data |
| Fluxo calculado | Soma das movimentações do intervalo — **não é saldo** |
| Saldo estimado | Âncora (saldo informado, ou saldo inicial declarado) + movimentações contabilizadas posteriores |
| Consolidado | Soma dos saldos estimados das contas ativas na mesma moeda; contas sem âncora ficam de fora e o consolidado aparece como **incompleto** |

Sem âncora, a interface mostra “sem âncora” — nunca deduz saldo de um extrato parcial. Saldo informado sem movimentações posteriores com data antiga aparece como “desatualizado”.

## Cartões

Compras, estornos, pagamentos, juros, tarifas, parcelas (`N/M`), limite e limite disponível (informados; nunca somados a saldos), fechamento e vencimento. O mês da fatura é **estimado** pelo dia de fechamento (compra após o fechamento vai para a fatura seguinte). Não há leitura de faturas eletrônicas nem dedução de parcelas futuras.

## Categorias e regras

16 categorias padrão editáveis (renomear atualiza a classificação local). Regras “descrição contém…” → categoria e/ou tipo, por conta ou globais; aplicadas em novas importações e sob demanda (“Aplicar regras agora”), sem tocar no que foi classificado à mão.
