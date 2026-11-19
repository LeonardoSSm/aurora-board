# Ciclo 4 — auditoria inicial (Finanças visuais e fórmulas)

Base: `main` em `4a208a4` (merge dos AI Tiles). Branch: `feature/visual-finance-formulas`.

## Baseline (antes de qualquer alteração)

| Comando | Resultado |
|---|---|
| `npm ci` | 1ª tentativa falhou com `EPERM` (servidor de desenvolvimento segurava `lightningcss.win32-x64-msvc.node`); após parar o servidor, ok, 0 vulnerabilidades |
| `npm run typecheck` | ok |
| `npm test` | 15 arquivos, 228 testes passando |
| `npm run build` | ok |
| `npm run test:e2e` (Chromium) | 29 passando |

## Como funciona hoje

- **Produção de valores:** cada `WidgetPlugin` declara `inputs`/`outputs` (`PortDef {id, label, type}`) e um `compute(data, inputs, element)` puro. Finanças expõe `summary` (`finance.summary`), `ledger` (`finance.ledger`) e `balance` (`number`, **reais em ponto flutuante**: `balanceCents / 100`).
- **Gráfico:** entradas `ledger` (`finance.ledger`) e `value` (`number`, lê `typeof === 'number'`); modos categorias, receitas × despesas, saldos; barras ou rosca.
- **Seleção de portas:** `findPortPair` percorre as entradas do destino e as saídas da origem e usa **o primeiro par compatível** (`in === 'any' || out === in`). Não há como escolher outra porta.
- **Ciclos:** Tarjan sobre as conexões válidas; conexões dentro de um componente fortemente conexo ficam com status `cycle` e não transmitem. Avaliação por Kahn (ordem topológica), `compute` com `try/catch`.
- **Memoização:** `getDataflow` recalcula quando muda a lista de tokens (ids, tipo, `data`, título dos widgets e pontas das conexões de dados). Cada recálculo cria objetos novos para todas as entradas/saídas, então **todos os widgets re-renderizam** a cada mudança de dados.
- **Esquema das conexões:** `ConnectionSchema = { kind, relation }` (zod remove campos desconhecidos). Campos novos precisam ser declarados como opcionais.
- **Migrações:** `migrateBoard` + `repairReferences` (vínculos órfãos, frames, grupos) em toda carga; cópia de segurança antes de reparar.
- **Duplicação:** `cloneElements` remapeia ids, grupos, frames, vínculos das setas e (desde o ciclo 3) ids citados em dados de widget via `remapIds`.
- **Exportação de widgets:** `exportSVG` do plugin quando existe; senão um cartão com resumo textual.
- **Períodos:** `inPeriod(ocorrência, 'AAAA-MM')` por prefixo da data de vencimento; parcelas via `expandEntry` (centavos restantes nas primeiras parcelas, dia ajustado ao fim do mês).

## Limitações relevantes para o ciclo

1. Primeiro par compatível: um mês com receitas, despesas, saldo e comprometimento não teria como escolher o que transmitir.
2. Tipo `number` mistura reais em ponto flutuante (Finanças) e números genéricos; não carrega moeda.
3. Sem nome estável por entrada: fórmulas não teriam como referenciar valores.
4. Recalcular cria objetos novos para todos os nós (re-render de todos os widgets).
5. Moeda divergente só é tratada dentro do Finanças (aviso); não há estado de conexão “moeda incompatível”.

## Arquitetura proposta

- **Três widgets nativos sem esquema novo** (`WidgetElement`): `aurora.value`, `aurora.finance-period`, `aurora.formula`, com moldura compacta (`frame: 'bare'`).
- **Valores tipados** (`core/scalar.ts`): `money` (centavos inteiros + moeda + papel receita/despesa/neutro + chave estável), `number` e `percent` (decimal de ponto fixo, 8 casas, em `bigint` — `core/decimal.ts`).
- **Portas explícitas:** `connection.sourcePort`, `connection.targetPort` e `connection.variable` opcionais. Sem eles, resolução legada idêntica à atual.
- **Portas aceitam listas de tipos** (`PortDef.accepts`) e podem depender dos dados (`ports(data)`), sem mudar os widgets antigos.
- **Problemas por conexão** informados pelo `compute` do destino (moeda, duplicidade, competência), exibidos como estado da conexão.
- **Recalcular reaproveitando** saídas de nós cujos dados e entradas não mudaram (referências estáveis → sem re-render).
- **Fórmulas:** tokenizador + parser descendente recursivo (AST) + avaliador tipado; sem `eval`/`Function`.

## Riscos

| Risco | Mitigação |
|---|---|
| Quebrar conexões antigas (Finanças → Gráfico, Finanças → Finanças) | Resolução legada mantida quando não há porta explícita; testes de regressão com a fixture congelada |
| Somar moedas diferentes | Moeda viaja no valor; mês, fórmula e gráfico recusam mistura com aviso |
| Dupla contagem | Chave estável por lançamento (`id do bloco` / `id do Finanças:lançamento:parcela`); repetidas contam uma vez, com aviso |
| Imprecisão | Centavos inteiros e decimal de ponto fixo em `bigint`; arredondamento explícito (meio para longe do zero) |
| Laços de re-render | Variáveis atribuídas na hora do commit (puro, no mesmo item de histórico), nunca em efeitos de render |
| Dados antigos | Só campos opcionais novos; nenhuma migração destrutiva; `SCHEMA_VERSION` inalterado |
