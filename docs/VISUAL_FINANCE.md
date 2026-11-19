# Finanças visuais

Valores, meses, fórmulas e gráficos como blocos livres no quadro, ligados por conexões do tipo **Dados**. Tudo é calculado localmente, de forma determinística; nenhuma API (nem de IA) participa dos cálculos.

## Uso rápido

1. **Biblioteca → Finanças visuais → Receita** (ou Despesa, Valor, Número, Porcentagem). O bloco já abre em edição: digite o valor (ex.: `3.000`), `Shift+Tab` para o nome, `Enter` confirma, `Esc` cancela.
2. **Mês**: insere a competência do mês atual; duplo clique abre o painel para escolher mês e ano. Botão direito → *Criar mês seguinte / anterior / próximos 11 meses*.
3. **Conectar**: ferramenta Conectar (`C`) → tipo **Dados** → arraste do valor até o mês. O mês soma receitas e despesas e mostra saldo e comprometimento.
4. **Fórmula**: conecte meses ou valores a um bloco Fórmula; cada conexão vira uma variável (ex.: `saldo_janeiro_2027`). Duplo clique para escrever `=SOMA(saldo_janeiro_2027, saldo_fevereiro_2027)`. O painel lista as variáveis, funções e modelos.
5. **Gráfico**: conecte meses (barras, linha, rosca ou números; modos Saldos, Receitas × Despesas, Categorias).
6. Alterou um valor? Mês, fórmulas e gráficos dependentes recalculam na hora.
7. Exemplo pronto: **Quadros → Exemplo: finanças** cria um quadro novo com dados fictícios.

Um texto com número (ex.: `Aluguel 1.500`) continua sendo texto; para virar valor use **botão direito → Converter em valor**.

## Blocos

| Bloco | Id | Saídas | Entradas |
|---|---|---|---|
| Valor | `aurora.value` | `value` (`money`, `number` ou `percent`, conforme o tipo) | — |
| Mês financeiro | `aurora.finance-period` | `summary` (`finance.period`), `balance`, `income`, `expenses` (`money`), `commitment` (`percent`) | `occurrences` (`finance.occurrences`), `entries` (`money`; aceita `scalar`) |
| Fórmula | `aurora.formula` | `result` (`scalar`) | `in` (`scalar`; aceita `money`, `number`, `percent`) |
| Finanças (existente) | `aurora.finance` | antigas: `summary`, `ledger`, `balance` (número); novas: `balanceMoney` (`money`), `occurrences` | `in` (`finance.summary`) |
| Gráfico (existente) | `aurora.chart` | — | antigas: `ledger`, `value`; nova: `series` (`finance.period`; aceita `money`, `number`, `percent`, `scalar`) |

Todos usam a moldura compacta (`frame: 'bare'`) e três modos: compacto (só o valor), normal e detalhado.

## Regras de cálculo do mês

- Totais **sempre derivados** das entradas conectadas; nada de totais gravados.
- Receita/despesa vêm do **papel** do valor, nunca do sinal: uma despesa de R$ 500 é gravada como `50000` centavos com papel `expense`.
- Valores **neutros** não entram no saldo (aparecem em “Neutros” no modo detalhado).
- **Comprometimento** = despesas ÷ receitas. Com receitas = 0 o resultado é indefinido e aparece como “— (sem receitas)”, nunca como 0% ou infinito.
- **Moeda** diferente da do mês: ignorado, com aviso na conexão. Não há conversão implícita.
- **Competência**: valor sem competência entra no mês conectado; com competência diferente é ignorado, com aviso (o valor não é alterado).
- **Duplicidade**: cada lançamento tem chave estável (`id do bloco`, ou `id do Finanças:lançamento:parcela`). A mesma chave por duas conexões conta uma vez, com aviso.
- **Finanças → mês**: usa as ocorrências de `expandEntry` (parcelas distribuídas, centavos restantes nas primeiras, dia ajustado ao fim do mês) e filtra pela competência do mês. O saldo total do Finanças **não** é tratado como receita.

## Precisão monetária

- Dinheiro em **centavos inteiros** (limite ±10¹⁵ centavos). Números e porcentagens em **decimal de ponto fixo com 8 casas** sobre `bigint` (`core/decimal.ts`).
- Soma e subtração são exatas. Multiplicação e divisão fazem **um** arredondamento explícito, **meio para longe do zero** (R$ 0,025 → R$ 0,03; R$ 10 ÷ 3 → R$ 3,33).
- Porque não `number`: `0,1 + 0,2 = 0,30000000000000004` em ponto flutuante. Com centavos e decimal fixo, `=0.1 + 0.2` dá `0,3`.
- Valores inválidos, `NaN`, infinito e fora dos limites são rejeitados na entrada e nunca saem de uma fórmula.

## Persistência e compatibilidade

- Os blocos são `WidgetElement` comuns: dados em `element.data`, portas e nomes nas conexões (`connection.sourcePort`, `targetPort`, `variable` — campos opcionais). `SCHEMA_VERSION` não mudou; não há migração destrutiva.
- IndexedDB, autosave por revisões, diário de recuperação, histórico, exportação/importação JSON e duplicação funcionam sem código específico.
- Duplicar um conjunto conectado leva as setas junto: as cópias ligam-se às cópias (as variáveis estão nas setas). Uma fórmula copiada sozinha mostra “Variável desconhecida”, nunca uma ligação silenciosa com outro bloco.
- Excluir um valor usado por uma fórmula deixa a seta “origem ausente” e a fórmula com erro visível; o documento continua íntegro.

## Desempenho

`npm run build && npx playwright test -c playwright.perf.config.ts e2e/perf/finance.perf.ts` (resultados em `perf-results/financas-visuais.json`). Composição: N valores, N/10 meses (10 valores cada), uma fórmula por mês encadeada na anterior e um gráfico com todos os meses. Build de produção, Chromium, i5-1135G7:

| Valores | Elementos | Recálculo completo | Recálculo após mudar 1 valor | Mudança até pintar | Passo de arrasto | Heap |
|---|---|---|---|---|---|---|
| 100 | 250 | 0,9 ms | 0,6 ms | 33 ms | 33 ms | 11 MB |
| 500 | 1.250 | 2,6 ms | 2,0 ms | 33 ms | 33 ms | 27 MB |
| 1.000 | 2.500 | 4,3 ms | 4,1 ms | 50 ms | 33 ms | 34 MB |

“33 ms” é o piso da medição (dois quadros de animação). O recálculo percorre o grafo inteiro (validação, ciclos, ordem topológica), mas reaproveita as saídas de nós cujos dados e entradas não mudaram: elas mantêm a mesma referência, e só os blocos afetados re-renderizam. Arrastar não recalcula (posição não entra no fluxo).

## Limitações

- Períodos são mensais; trimestres/anos ainda não.
- Sem conversão de moedas (por desenho). Sem integração bancária ou importação de extratos.
- Conexões antigas, sem portas, continuam na resolução automática até serem religadas; o nome de variável delas é derivado do título da origem (renomear a origem muda o nome até a conexão ser religada).
- O Gráfico na tela é HTML; na exportação PNG/SVG é redesenhado em SVG com os mesmos números (aparência semelhante, não idêntica).
- Rótulos nas setas aparecem só para conexões selecionadas ou ligadas à seleção, e só quando informam algo.
