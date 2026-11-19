# Importação de extratos (CSV e OFX)

Importação **manual** de arquivos exportados pelo seu banco. Não é Open Finance: o arquivo é lido só no navegador, nada é enviado para a internet e nenhum arquivo dispara requisições.

## Fluxo

Arquivo → identificar formato → escolher conta → mapear colunas (CSV) → **prévia** → conciliação → **Confirmar importação**.

- Cancelar em qualquer etapa não grava nada.
- A prévia mostra conta, intervalo, quantidade, entradas, saídas, novas, já importadas, possíveis duplicidades, conflitos, pendentes atualizadas, inválidas, ignoradas e o saldo informado (OFX). Cada linha pode ser incluída/excluída.
- Se o número mascarado do arquivo (OFX) não bater com a conta escolhida, aparece um aviso (evita misturar contas). Um OFX cuja conta já existe é associado automaticamente.

## CSV

| Suporte | Detalhes |
|---|---|
| Codificação | UTF-8 (com ou sem BOM); se não for UTF-8 válido, Windows-1252 (comum em bancos brasileiros) |
| Delimitador | `;`, `,`, tab ou `|` — detectado, editável |
| Aspas | RFC 4180: campos entre aspas, aspas duplicadas (`""`), quebras de linha dentro do campo; aspas não fechadas recusam o arquivo |
| Cabeçalho | Procurado nas primeiras 30 linhas (extratos têm preâmbulo); sinônimos em pt-BR e inglês (`Data`, `Histórico`, `Descrição`, `Valor`, `Crédito`, `Débito`, `Saldo`, `Documento`, `Categoria`, `date`, `description`, `amount`…). Sem cabeçalho, as colunas são deduzidas pela primeira linha e podem ser mapeadas à mão |
| Valores | Uma coluna com sinal, ou colunas separadas de crédito/débito; separador decimal **por arquivo** (detectado; vírgula ou ponto), milhar validado em grupos de 3, `(1,00)`, `1,00-`, `1,00 D/C`, `R$`. Mais de 2 casas decimais ou separadores inválidos = linha inválida (nunca arredondado em silêncio) |
| Datas | `DD/MM/AAAA`, `DD/MM/AA`, `DD-MM-AAAA`, `AAAA-MM-DD`, `AAAAMMDD`, ISO com hora (a data civil é mantida; sem conversão de fuso). Datas impossíveis são inválidas. Ordem mês/dia escolhível |
| Linhas especiais | “SALDO ANTERIOR/DO DIA/TOTAL” e valor zero são ignoradas (listadas). Status “pendente/agendado” vira pendente. “N/M” na descrição vira parcela |
| Sinal | Opção **Inverter sinal** para faturas de cartão que listam compras como positivas |
| Colunas desconhecidas | Ignoradas |

Limites: 20 MB, 100 mil linhas, 60 colunas, 4.000 caracteres por campo. Excedeu = arquivo recusado (nada truncado).

Não há perfis específicos por banco neste ciclo: nenhum formato real de banco foi avaliado (não há extratos reais no repositório, por desenho). O mapeamento manual cobre layouts diferentes; perfis podem ser acrescentados depois a partir de arquivos reais do usuário, avaliados localmente.

## OFX

| Suporte | Detalhes |
|---|---|
| Versões | OFX 1.x SGML (tags sem fechamento) e 2.x XML |
| Extratos | Conta (`STMTRS` / `BANKACCTFROM`) e cartão (`CCSTMTRS` / `CCACCTFROM`); vários extratos no mesmo arquivo (escolha na tela) |
| Campos | `FITID`, `DTPOSTED`, `DTUSER`, `TRNAMT`, `NAME`, `MEMO`, `TRNTYPE`, `CHECKNUM/REFNUM`, `CURDEF`, `LEDGERBAL`/`AVAILBAL` (saldo informado), `DTSTART/DTEND`, `FI/ORG`, `BANKID`, `ACCTID` (guardado só mascarado) |
| Valores | Ponto (padrão); vírgula aceita (alguns bancos brasileiros); 3+ casas só se forem zeros |
| Recusados | `<!DOCTYPE`/`<!ENTITY` (XXE), arquivos sem `<OFX>`, sem extrato bancário/cartão (investimentos, faturas eletrônicas), moedas fora de BRL/USD/EUR, aninhamento > 32, > 600 mil nós ou > 100 mil movimentações |

O leitor é próprio (tokenizador), sem `DOMParser` nem bibliotecas XML: sem entidades externas, sem rede, mesmo comportamento em todos os navegadores e nos testes.

## Deduplicação e reimportação

Ver [RECONCILIATION.md](RECONCILIATION.md). Em resumo: importar o mesmo arquivo de novo não duplica; arquivos com períodos sobrepostos só acrescentam o que é novo; conflitos e possíveis duplicidades aparecem na prévia.

## Exportação CSV

Transações → **Exportar CSV** exporta o conjunto filtrado (`;`, UTF-8 com BOM). Textos que começam com `=`, `+`, `-`, `@`, tab ou CR são prefixados com `'` (proteção contra injeção de fórmulas ao abrir numa planilha); números puros continuam números.
