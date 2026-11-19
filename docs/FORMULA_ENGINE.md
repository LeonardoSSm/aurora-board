# Motor de fórmulas

`src/core/formula.ts`. Tokenizador → parser descendente recursivo (AST) → avaliador tipado. Não há `eval`, `new Function`, acesso a objetos globais nem execução de código: só existem os operadores e funções abaixo. Conteúdo importado é tratado como texto e passa pelo mesmo parser.

## Gramática

```
formula  := '='? expr
expr     := term (('+' | '-') term)*
term     := unary (('*' | '/') unary)*
unary    := ('-' | '+') unary | postfix
postfix  := primary '%'?
primary  := número | nome '(' args? ')' | nome | '(' expr ')'
args     := expr ((',' | ';') expr)*
```

- Números usam **ponto** decimal: `0.20`. (`1,5` fora de uma função é erro com dica; dentro de uma função, a vírgula separa argumentos.)
- `20%` = 0,2. Uma variável de porcentagem também vale a fração (`salario * reserva` com reserva 20% → 20% do salário).
- Nomes de variáveis e funções ignoram maiúsculas e acentos (`MÉDIA` = `media`).
- Limites: 1.000 caracteres, 400 nós, 40 níveis de aninhamento.

## Funções

| Função | Aliases | Descrição |
|---|---|---|
| `SOMA(a, b, …)` | `SUM` | Soma |
| `MEDIA(a, b, …)` | `MÉDIA`, `AVERAGE` | Média (dinheiro arredondado ao centavo) |
| `MINIMO(a, b, …)` | `MÍNIMO`, `MIN` | Menor valor |
| `MAXIMO(a, b, …)` | `MÁXIMO`, `MAX` | Maior valor |
| `ABS(x)` | — | Valor absoluto |
| `ARRED(x, casas)` | `ARREDONDAR`, `ROUND` | Arredonda (meio para longe do zero); dinheiro: até 2 casas |

## Tipos

| Operação | Resultado |
|---|---|
| dinheiro ± dinheiro (mesma moeda) | dinheiro |
| dinheiro ± número | dinheiro (o número vira valor na mesma moeda) |
| dinheiro ± porcentagem | **erro** (use `valor * 10%`) |
| dinheiro × número/porcentagem | dinheiro (1 arredondamento ao centavo) |
| dinheiro × dinheiro | **erro** |
| dinheiro ÷ dinheiro (mesma moeda) | número (razão) |
| dinheiro ÷ número/porcentagem | dinheiro (1 arredondamento) |
| número/porcentagem ÷ dinheiro | **erro** |
| moedas diferentes em qualquer operação | **erro** (sem conversão automática) |
| qualquer coisa ÷ 0 | **erro** “Divisão por zero” |
| porcentagem ± porcentagem | porcentagem |

Resultados fora de ±10¹⁵ (ou ±10¹⁵ centavos) são erro. Nenhum caminho produz `NaN` ou `Infinity`.

## Variáveis

Cada conexão de dados que chega à fórmula tem um **nome lógico estável** gravado na própria conexão (`connection.variable`), criado no momento em que a conexão é feita:

- valor ou resultado principal: título da origem (`Salário` → `salario`);
- outra saída: palavra da porta + título (`Saldo` de `Janeiro 2027` → `saldo_janeiro_2027`);
- nomes repetidos no mesmo destino recebem sufixo (`_2`, `_3`).

Renomear o bloco de origem **não** muda o nome. Renomear a variável no painel da fórmula atualiza as referências na expressão no mesmo item de histórico. Uma variável sem conexão aparece como erro “Variável desconhecida”.

## Exemplos

```
=receitas - despesas
=salario * 0.20
=salario * 20%
=saldo_janeiro + saldo_fevereiro
=SOMA(salario, bonus)
=MEDIA(janeiro, fevereiro, marco)
=MAXIMO(janeiro, fevereiro)
=(despesas / receitas) * 100
=ARRED(total / 3, 2)
```

Modelos prontos no painel: receitas menos despesas, comprometimento, soma de saldos, diferença entre meses, média, percentual de um valor.
