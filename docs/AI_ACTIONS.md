# Ações da IA — contrato v2

O bloco **Assistente IA** (`aurora.ai`) pode propor alterações no quadro: notas, listas de tarefas, conexões,
**blocos de valor** (`aurora.value`) e **lançamentos em Finanças** (`aurora.finance`). A proposta é só uma
sugestão: nada é criado ou alterado sem prévia, botão explícito e diálogo de confirmação.

Código: `src/integrations/aiActions.ts` (contrato, validação, destinos, plano), `src/widgets/builtin/aiProposal.tsx`
(prévia e confirmação), `src/store/actions.ts › applyBatch` (aplicação atômica). Testes:
`tests/unit/ai-actions.test.ts` e `e2e/ai-actions.spec.ts`.

## Por que v2

Problema reproduzido: o pedido “Crie um bloco de receita de R$ 2.000,00” gerava uma **Nota** chamada “Receita”.
Causa: o contrato v1 (`{ notes, tasks, connections }`) não tinha como expressar um valor financeiro — o modelo
fazia o melhor possível com o que existia. O v2 descreve ações tipadas, e o prompt traz esse exemplo exato.

## Formato

A resposta da IA termina com **um** bloco ```` ```json ```` (se houver vários, vale o último):

```json
{ "version": 2, "actions": [ { "type": "create_value", "role": "income", "currency": "BRL", "amount": "2000.00" } ] }
```

| `type` | Campos | Efeito |
|---|---|---|
| `create_note` | `title?` (≤ 200), `content` (markdown, ≤ 20 000) | Nova nota |
| `create_tasks` | `title?`, `tasks[1..100]: { text, priority?: low\|medium\|high }` | Nova lista de tarefas |
| `connect` | `from`, `to`, `label?` | Seta entre dois blocos **do contexto autorizado** |
| `create_value` | `amount`/`amountCents`, `role?: income\|expense\|neutral`, `currency?`, `title?` (≤ 80), `period?: AAAA-MM`, `category?`, `note?`, `ambiguous?` | Novo **bloco de valor** independente (`aurora.value`, tipo dinheiro) |
| `add_finance_entry` | `amount`/`amountCents`, `kind: income\|expense`, `target?`, `currency?`, `description?`, `date?: AAAA-MM-DD`, `category?`, `paid?`, `installments?: 1..360`, `installmentMode?: split\|repeat`, `ambiguous?` | **Lançamento** num bloco de Finanças existente (ou num novo, se o usuário escolher) |

Limites: 80 ações por proposta. Campos desconhecidos são descartados.

### Tolerância de formato (observada com modelo real)

Teste manual com OpenAI `gpt-4.1-mini` (19/11/2026) mostrou dois desvios: o modelo pediu “Confirma a criação?” em
texto, sem JSON, e na resposta seguinte mandou o JSON **sem a cerca** ```` ```json ````. Por isso:

- o prompt diz explicitamente para não pedir confirmação em texto (a interface já confirma) e sempre usar a cerca —
  após a mudança, o mesmo modelo respondeu no formato certo na primeira tentativa;
- a proposta é procurada, nesta ordem: último bloco ```` ```json ````/```` ```JSON ```` (ou ```` ``` ```` sem linguagem
  começando com `{`); a resposta inteira, se for um objeto JSON; um objeto no fim do texto que comece por uma chave
  do contrato (`{"version"`, `{"actions"`, `{"notes"`…). Código em outra linguagem e texto comum não são lidos como
  proposta. Tudo continua passando pela mesma validação; o trecho JSON é ocultado do texto exibido.

### Dinheiro

- `amount` é **texto decimal** com ponto, até 2 casas, sem separador de milhar: R$ 2.000,00 → `"2000.00"`.
  A conversão para centavos é feita com inteiros (`BigInt`), sem ponto flutuante: `"2000.00"` → `200000`.
- Número JSON só é aceito se sua forma decimal exata tiver até 2 casas (`2000`, `1234.56`). `2000.005`,
  `0.1 + 0.2`, `1e21`, negativos, `NaN` e `Infinity` são recusados — o arredondamento binário nunca decide centavos.
- `amountCents` (inteiro) é alternativa; se vier junto com `amount` e divergir, a ação é recusada.
- Zero, valores acima de 10¹⁵ centavos, `"2.000,00"`, `"2,000.00"` e `"-5"` são recusados. O sinal vem de
  `role`/`kind`, nunca do valor.
- Moeda: `BRL`, `USD` ou `EUR`. Lançamento em bloco de outra moeda é bloqueado (sem conversão implícita, mesma
  regra de `core/finance.ts`).

## Validação (o modelo é uma fonte não confiável)

1. Cada ação é validada isoladamente com Zod (`SCHEMAS` em `aiActions.ts`). Inválidas aparecem na prévia como
   “Ignorada (ação N, tipo): motivo”; as válidas seguem. Tipo desconhecido (inclusive `__proto__`) é recusado.
2. Conexões e destinos financeiros só aceitam ids do **contexto autorizado**; destinos também podem ser blocos de
   Finanças ligados ao assistente por **conexão de execução** (mesma regra das tarefas). Nenhum outro bloco é
   alcançável.
3. Ações idênticas dentro da mesma proposta são reduzidas a uma (com aviso).
4. Ao confirmar, tudo é **revalidado contra o estado atual** do quadro; se o efeito mudou enquanto o diálogo estava
   aberto, nada é aplicado e o usuário revisa de novo.

## Bloco independente × lançamento

| Situação | Destino pré-selecionado |
|---|---|
| `create_value` | Novo bloco de valor |
| `add_finance_entry` com `target` permitido | Esse bloco de Finanças |
| `add_finance_entry` sem `target` e um único bloco compatível | Esse bloco |
| `ambiguous: true`, `target` fora do permitido, 0 ou 2+ blocos possíveis | **Nenhum — o usuário escolhe** (aplicar fica desabilitado) |

O seletor de destino sempre permite trocar entre: novo bloco de valor, lançamento em cada bloco de Finanças
permitido e novo bloco de Finanças. Opções incompatíveis aparecem desabilitadas com o motivo (moeda diferente,
valor neutro em lançamento, parcelas em bloco de valor).

## Dados ausentes: padrões, nunca invenção

| Campo ausente | Bloco de valor | Lançamento |
|---|---|---|
| Moeda | BRL (padrão do sistema) | moeda do bloco de destino |
| Título/descrição | nome do tipo (“Receita”, “Despesa”, “Valor”) | vazia |
| Competência / data | “do mês conectado” | sem vencimento (aparece em “Todo o período”) |
| Categoria | nenhuma | “Sem categoria” |
| Classificação (`role`) | Neutro | — (`kind` é obrigatório) |
| Pago / parcelas | — | não pago; 1 parcela (parcelas > 1 exigem data) |

Todo padrão aplicado é listado na prévia (“Padrões: …”). Data informada num bloco de valor vira a competência do
mesmo mês (com aviso); competência num lançamento **não** vira data.

## Prévia e confirmação

Cada ação mostra: tipo, classificação, valor formatado, moeda, centavos, destino, efeito (“Adiciona receita
+R$ 2.000,00 em ‘Casa’ — saldo previsto R$ 0,00 → R$ 2.000,00”), padrões e avisos. Cada ação pode ser desmarcada.
“Revisar e aplicar…” abre o diálogo com a lista final de efeitos; só “Aplicar no quadro” altera algo.

**Conferência local do pedido** (`interpretFinancialRequest`): o texto do usuário é lido sem o modelo (classificação,
um único valor com moeda, intenção bloco/lançamento). Serve para:

- avisar quando a IA diverge do pedido (valor, moeda ou classificação);
- quando a IA **não** propõe ação financeira mas o pedido é inequívoco (classificação + valor com moeda + intenção),
  exibir um segundo cartão “Interpretação local do seu pedido” — também só com prévia e confirmação.

## Aplicação, duplicidade e desfazer

- Tudo o que a proposta faz (elementos novos, lançamentos e a marca “aplicada” no bloco de IA) entra em **uma**
  entrada de histórico (`applyBatch`). Ctrl+Z desfaz o conjunto e reabre a proposta; Ctrl+Y refaz os dois.
- A marca `applied[chave da mensagem]` impede aplicar a mesma proposta de novo (persistida nos dados do bloco).
- Lançamentos recebem id determinístico `ai-<mensagem>-<índice>`: reaplicar no mesmo bloco não duplica, e a prévia
  avisa quando já existe lançamento igual (mesmo tipo, valor, data e descrição).
- Duplicidade **entre mensagens** (ex.: interpretação local numa resposta e a mesma ação vinda da IA na seguinte):
  a prévia e o diálogo de confirmação avisam quando já existe bloco de valor com o mesmo papel, valor e moeda.
- Proposta já aplicada mostra só o destino usado (não recalcula o efeito contra o quadro que ela mesma alterou).
- Clique duplo no botão é ignorado enquanto a confirmação está em andamento.

## Compatibilidade

- Respostas antigas `{ notes, tasks, connections }` (inclusive as já gravadas nas conversas) são convertidas para
  ações v2 e exibidas na mesma prévia. `parseProposal` (v1) continua exportado em `aiContext.ts`.
- “Enviar para ‘Tarefas’…” (conexão de execução) continua disponível para tarefas propostas.
- Dados antigos do bloco de IA sem `applied` são válidos (`sanitizeAI` preenche `{}`).
- O contexto enviado ao modelo não mudou: só blocos conectados por contexto/dados e autorizados.

## Aurora Artifacts (contrato v3)

No modo **Criar ou editar Artifact**, o Assistente envia o pedido e os metadados dos blocos que você escolheu. Para refinar um painel, revise o código e as portas na tela e autorize o envio ao provedor em cada pedido. O histórico convencional do Assistente, os valores das portas e o estado do painel ficam fora desse envio. Respostas de Artifact ficam na conversa local e fora do contexto e da saída `reply` usados pelo chat convencional.

| `type` | Campos |
|---|---|
| `create_html_widget` | `title` (até 80 caracteres), `html` (até 32 mil caracteres) |
| `update_html_widget` | `target` (`@artifact` ou o ID do painel escolhido), `html` completo |
| `configure_html_ports` | `target`, `inputs`, `outputs`. Cada porta tem `id`, `label` e `type` |
| `connect_data` | `from`, `sourcePort`, `to`, `targetPort`. Pelo menos uma ponta é o painel em revisão e a outra deve estar entre os blocos escolhidos |

`{ "version": 3, "actions": [...] }` aceita até 14 ações, um painel e uma configuração completa de portas por proposta. `@artifact` é uma referência local à proposta. O host aplica o conjunto inteiro após validar campos, código autocontido, IDs, tipos, conexões e ciclos. Uma revisão que invalidaria uma conexão existente fica bloqueada até o usuário ajustar a proposta ou a conexão. Pode-se salvar pausado ou confirmar a execução. O escopo de aplicação vale na sessão do quadro, e o histórico local guarda o estado de aplicação. O chat convencional segue com as ações v1 e v2. Consulte o [guia e relatório da implementação](ARTIFACTS_IMPLEMENTATION.md).
