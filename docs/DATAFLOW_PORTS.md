# Fluxo de dados: portas e contratos

`src/core/dataflow.ts`. Só conexões `kind: 'data'`, ancoradas nas duas pontas em widgets, transmitem valores. Setas visuais, de contexto e de execução **nunca** calculam.

## Conexão

```ts
connection: {
  kind: 'visual' | 'context' | 'data' | 'execution';
  relation: string;
  sourcePort?: string;   // saída escolhida na origem
  targetPort?: string;   // entrada escolhida no destino
  variable?: string;     // nome lógico estável no destino (ex.: variável de fórmula)
}
```

- **Sem portas** (conexões antigas): resolução legada, idêntica às versões anteriores — o primeiro par compatível, percorrendo as entradas do destino e as saídas da origem.
- **Com portas**: usa exatamente essas. Porta inexistente → `missing-port`; tipo não aceito → `incompatible`.
- **Conexões novas** (criadas ou religadas): no mesmo commit, as portas são fixadas pela sugestão por tipo (`suggestPorts`: para cada entrada do destino, a saída do tipo principal e depois dos aceitos) e o nome lógico é atribuído. O usuário pode trocar saída, entrada e nome no painel da conexão, que também mostra o valor transmitido.

## Portas

```ts
interface PortDef { id: string; label: string; type: string; accepts?: string[] }
```

`input` aceita `output` se `input.type === 'any'`, `input.type === output.type` ou `input.accepts` contém `output.type`. Um plugin pode declarar `ports(data)` para portas que dependem dos dados (o Valor expõe `money`, `number` ou `percent`).

## Tipos de valor

| Tipo | Conteúdo |
|---|---|
| `money` | `{ t: 'money', cents, currency, role?, key?, label?, period?, category? }` — centavos inteiros |
| `number` | `{ t: 'number', v: '12.5' }` (decimal exato) ou, em saídas antigas, um `number` JS |
| `percent` | `{ t: 'percent', v: '0.15' }` (fração) |
| `scalar` | qualquer um dos três acima (saída de fórmula) |
| `finance.period` | resumo do mês: período, moeda, receitas, despesas, saldo, comprometimento, categorias |
| `finance.occurrences` | ocorrências (parcelas) do Finanças, com competência |
| `finance.summary`, `finance.ledger` | formatos existentes do Finanças |

## Estados da conexão

`ok` · `incompatible` (tipo) · `missing-port` (porta inexistente) · `unbound` (origem ou destino ausente) · `not-widget` · `cycle` · `currency` (moeda incompatível) · `duplicate` (lançamento repetido) · `period` (competência diferente). Os três últimos são informados pelo `compute` do destino em `$issues` e aparecem na seta e no painel.

## Ciclos e cálculo

Tarjan marca conexões em ciclos (`cycle`) e as desativa; a avaliação segue Kahn (ordem topológica), com `compute` puro e protegido por `try/catch`. Com o resultado anterior, um nó cujo elemento e entradas não mudaram reaproveita o mesmo objeto de saída: os dependentes não re-renderizam.

## Exemplos de conexões

| Origem → destino | Porta sugerida |
|---|---|
| Valor (dinheiro) → Mês | `value` → `entries` |
| Finanças → Mês | `occurrences` → `occurrences` |
| Mês → Fórmula | `balance` → `in` (troque para `income`, `expenses` ou `commitment` no painel) |
| Mês → Gráfico | `summary` → `series` |
| Fórmula → Gráfico | `result` → `series` |
| Finanças → Fórmula | `balanceMoney` → `in` |
| Finanças → Gráfico (antiga) | `ledger` → `ledger` (resolução legada inalterada) |
