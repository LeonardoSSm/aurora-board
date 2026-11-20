# Data Hub — dados importados (issue #24)

Fonte de dados **local-first** para dashboards: o usuário importa um CSV ou JSON, confere a prévia, guarda no
próprio dispositivo e conecta o conjunto a Fórmulas, Gráficos e blocos HTML pelo fluxo de dados. Nada vai para
servidor, IA ou rede.

| Entrega | Escopo | Estado |
|---|---|---|
| **D2-A** | Bloco `aurora.dataset`, importação/validação, persistência, exportação segura, projeção para o fluxo de dados, backup | este documento |
| D2-B | Dashboards HTML conectados (exemplos, publicação de métricas) | próximo PR |
| D2-C | Atualização reativa e UX de substituição, consentimento granular para IA | próximo PR |

## Arquitetura

```
arquivo (gesto do usuário) ──▶ parseDatasetText (puro: limites, tipos) ──▶ PRÉVIA ──confirma──▶ saveDataset
                                                                                              │
                     asset imutável `application/vnd.aurora.dataset+json` (IndexedDB aurora-board/assets)
                                                                                              │
bloco aurora.dataset { source: { assetId, nome, contagens, origem }, view } ◀── referência ───┘
        │ compute (síncrono, lê o cache validado; carrega sob demanda e chama bumpExternalData)
        ▼
saídas: rows (página) · columns · summary · count ──▶ Fórmula / Gráfico / HTML (Bridge, D2-B)
```

| Módulo | Papel |
|---|---|
| `src/data/model.ts` | Tipos, limites, chaves seguras de coluna, validação estrita do conteúdo guardado |
| `src/data/parse.ts` | Leitura de CSV e JSON (puro; nada é executado) |
| `src/data/export.ts` | CSV seguro para planilhas e JSON reimportável |
| `src/data/codec.ts` | Conteúdo ↔ asset (base64), validação ao ler — usado também pela importação de backups |
| `src/data/store.ts` | Gravação, leitura sob demanda, cache LRU por células e recálculo do fluxo de dados |
| `src/data/project.ts` | Projeção limitada para as saídas (página, colunas, estatísticas, cortes informados) |
| `src/widgets/builtin/dataset.tsx` | Bloco, prévia, importação/substituição, exportação, exclusão, painel |

### Decisão: o conteúdo é um asset imutável

O conjunto normalizado (`{ format: 'aurora-dataset', version: 1, columns, rows }`, linhas como **listas**) é
gravado como um asset local com tipo próprio. O bloco guarda só a referência e metadados — nunca células.

- **Por que não um banco IndexedDB novo:** os backups de quadros já carregam os assets referenciados, com limites,
  validação, aviso de ausentes e gravação **atômica** (uma transação para assets + quadros + workspace). Um banco
  separado não entraria na mesma transação. Também não há mudança de esquema nem migração (`schemaVersion` 3).
- **Imutável (copy-on-write):** substituir os dados cria um asset novo. Duplicar/copiar o bloco compartilha o
  mesmo asset; o desfazer continua apontando para um conteúdo existente.
- **Nunca** em `aurora.setState`, nas saídas efêmeras do HTML Data Bridge (`htmlOutputs`), no razão financeiro
  (`aurora-finance`) nem no JSON do quadro.
- Leitura sempre validada (`validateContent`): um asset pode vir de um backup forjado. As chaves técnicas das
  colunas são **recalculadas** a partir dos rótulos ao ler — o arquivo não escolhe chaves.

## Formatos aceitos

### CSV

- UTF-8 (com ou sem BOM). Arquivo binário (ex.: `.xlsx`) ou UTF-8 inválido é recusado com orientação.
- RFC 4180: aspas, aspas duplicadas (`""`), quebras de linha dentro de campos, CRLF/LF/CR.
- Delimitador detectado entre `,` `;` TAB `|` pela consistência numa amostra de 64 KB (cortada no fim de uma linha — LF, CRLF ou só CR; se o corte cair dentro de um campo entre aspas, cortes menores são tentados). **Primeira linha = cabeçalho.**
- Toda linha precisa ter o número de campos do cabeçalho; separadores vazios a mais no fim são tolerados (aviso).
  Qualquer outra diferença recusa o arquivo inteiro, com o número da linha.
- Tipos por coluna: **número** (ponto decimal; formato brasileiro `1.234,56` só quando algum valor tem vírgula
  decimal), **sim/não** (`true`/`false`), **data** (ISO `AAAA-MM-DD[THH:MM[:SS]]`, mantida como texto) e **texto**.
  Zeros à esquerda (CEP, códigos) e inteiros com mais de 15 dígitos continuam texto — nada de perder dígitos.
  Campo vazio vira nulo.

### JSON (duas variantes)

1. **Lista de objetos** — `[{ "produto": "Café", "valor": 10.5 }, …]`. Colunas na ordem em que aparecem; campo
   ausente = nulo.
2. **Colunas + linhas** — `{ "columns": ["produto", { "label": "valor" }], "rows": [["Café", 10.5]] }` (linhas como
   listas ou objetos). É o formato da exportação JSON do app (com `format: "aurora-dataset"`).

Células: texto, número, `true`/`false` ou `null`. Objetos/listas numa célula viram o texto JSON dela (aviso). Backups
do Aurora Board são reconhecidos e recusados com a indicação do caminho certo (Importar → Arquivo JSON).

### Nomes de coluna

O rótulo original (limpo de caracteres de controle e de direção) é exibido e exportado. A **chave técnica** usada
nas saídas `rows` é o próprio rótulo, exceto quando vazio (`Coluna N`), repetido (`nome_2`) ou reservado —
`__proto__`, `constructor`, `prototype`, `key`, `members` e nomes iniciados por `$` recebem `_` no fim (o HTML Data
Bridge remove `key`/`members`/`$…` de valores, e as três primeiras poluiriam protótipos). A prévia avisa.

## Limites

| Item | Limite |
|---|---|
| Arquivo | 26 MB (conferido antes de ler) — o limite de armazenamento (24 MB) + 2 MB, para que todo dado guardado possa ser exportado em CSV/JSON e reimportado |
| Linhas / colunas / células | 50.000 / 100 / 1.000.000 |
| Texto por célula / rótulo | 10.000 (+1 só para o apóstrofo anti-fórmula de um CSV exportado) / 120 caracteres |
| JSON bruto | 32 níveis, 3 milhões de itens (antes de converter) |
| Conteúdo guardado | 24 MB (bytes UTF-8) de JSON normalizado — a mesma unidade na gravação e na leitura; o asset em base64 cabe no limite de 36 MB dos backups |
| Cache em memória | 3 milhões de células (LRU); datasets do quadro aberto nunca são despejados (o teto pode ser ultrapassado por eles) |

Acima de qualquer limite o arquivo é recusado **inteiro**, com a causa, e **nada** é gravado. Cancelar a prévia
também não grava nada.

## Saídas do bloco (fluxo de dados)

| Porta | Tipo | Conteúdo |
|---|---|---|
| `rows` | `object` | Página atual: lista de objetos `{ chave: valor }` com as colunas escolhidas |
| `columns` | `object` | `[{ key, label, type }]` de todas as colunas |
| `summary` | `object` | `name`, `rowCount`, `columnCount`, `page`, `pageSize`, `pageCount`, `offset`, `rowsInPage`, `projectedColumns`, `truncated`, `notes`, `stats` (por coluna numérica: `count`, `sum`, `min`, `max`, `mean`) |
| `count` | `number` | Número de linhas (decimal exato) — serve direto a Fórmulas |

**O conjunto inteiro nunca é enviado.** Página de até 500 linhas, até 50 colunas nas linhas, textos de célula
encurtados a 2.000 caracteres e cada saída limitada a 60 KB de JSON — abaixo do limite de **valor** do HTML Data
Bridge (64 KB); as quatro juntas ficam abaixo do limite de **entrada** (1 MB). Quando algo é cortado,
`summary.truncated = true` e `summary.notes` explica o quê; o painel mostra o aviso. Paginação e colunas são
escolhidas no painel do bloco (opções de exibição gravadas no bloco).

A projeção é memoizada por conteúdo + visão: recalcular o fluxo de dados (ex.: um HTML publicando) não refaz
estatísticas nem cria objetos novos.

## Exportação

- **CSV:** BOM UTF-8, separador vírgula, CRLF, escape RFC 4180. **Proteção contra fórmulas em planilhas:** um
  texto cujo primeiro caractere significativo — depois de espaços, caracteres de controle e de largura zero — é
  `=`, `+`, `-`, `@` (ou as variantes de largura total `＝＋－＠`), ou que começa com TAB/CR, recebe `'` na frente e
  vai entre aspas (texto que já começa com apóstrofos seguidos de algo assim também recebe um). Números de colunas
  numéricas saem como números (`-5` continua número). Cabeçalhos também são neutralizados. **Ida e volta exata:** ao
  importar um CSV, o app remove esse apóstrofo (como as planilhas fazem com `'` inicial) — o valor volta a ser o
  original, continua **texto** (nada é avaliado) e é neutralizado de novo em toda exportação.
- **JSON compacto:** `{ format: 'aurora-dataset', version: 1, name, exportedAt, columns: [{ label, type }], rows }` —
  tamanho próximo ao do conteúdo guardado; reimportável sem perda (Unicode, aspas e quebras de linha preservados).
- Os downloads são disparados pela interface do host (botões do bloco, painel e menu de contexto). O HTML
  isolado não exporta nem importa nada.

## Backup, restauração, duplicação e exclusão

| Situação | Comportamento |
|---|---|
| Exportar **este quadro** ou **backup do workspace** (JSON) | Se algum bloco usa dados importados, o app **pergunta**: “Incluir dados” ou “Sem os dados” (ou cancelar). Sem os dados, os blocos restaurados mostram “dados não disponíveis neste dispositivo”. |
| **Backup pessoal completo** (Minhas contas → Privacidade) | Inclui os dados importados; a confirmação diz isso. Pode ser cifrado. |
| Importar backup | Datasets do arquivo são **validados por inteiro antes de gravar** e, depois de gravados, qualquer “ausente” em cache é esquecido (o bloco volta sem recarregar a página); inválidos são descartados com aviso (o bloco fica sem dados). Ausentes geram o aviso “arquivo ausente no backup”. Tudo entra numa **única transação** (falha = nada gravado). |
| Conflito de id | Mesmo id e mesmo conteúdo: nada é duplicado. Mesmo id com conteúdo **diferente**: o do backup ganha id novo e os blocos importados passam a apontar para ele — nunca exibem o dado local no lugar do importado. |
| Duplicar / copiar bloco | Compartilha o asset imutável; substituir os dados de uma cópia não afeta a outra. |
| Trocar de workspace | Os assets são do dispositivo; blocos de qualquer workspace continuam lendo seus dados. |
| **Excluir dados deste dispositivo** (painel) | Confirmação; se nenhum outro bloco (em qualquer quadro) usa o mesmo arquivo, ele é apagado do IndexedDB; senão só este bloco é esvaziado (avisado). Excluir o bloco **não** apaga o arquivo (como imagens): o desfazer continua funcionando. |
| Backups financeiros | Inalterados: o Data Hub não toca no razão (`aurora-finance`). |

## Privacidade e IA

- Os dados ficam no dispositivo. Nenhuma chamada de rede.
- `aiContext` do bloco: sempre **não autorizado** (D2-A). `financialTaint` trata `aurora.dataset` como fonte
  protegida: Fórmula, HTML ou qualquer bloco que dependa (direta ou indiretamente) de dados importados também não é
  enviado à IA. O consentimento granular chega no D2-C.
- O resumo textual do bloco (busca, exportação PNG/SVG, contexto genérico) traz só o título e as contagens —
  nem valores, nem nomes de colunas.
- Mensagens de erro nunca ecoam conteúdo do arquivo além do número da linha e do rótulo da coluna.
- A tabela é renderizada como texto (nós React); nenhum dado importado passa por `innerHTML`.

## Testes

- `tests/unit/data-hub.test.ts` (65): CSV (BOM, aspas, quebras, delimitadores, decimal brasileiro, zeros à
  esquerda, inconsistência, cabeçalhos perigosos, binário/UTF-8, limites, fórmulas importadas como texto), JSON (duas
  variantes, células aninhadas, `__proto__`/`constructor` sem poluição, profundidade/itens, backups recusados),
  validação do conteúdo guardado, codec, exportação (escape, 14 variantes de fórmula, números intactos, ida e volta
  CSV/JSON), projeção (paginação, limites de 64 KB/1 MB, cortes informados, estatísticas), persistência e cache,
  bloco (sanitize idempotente e anti-forja, estados, Dados → Fórmula/HTML), privacidade (resumo, IA direta e
  transitiva) e backup (restauração atômica, adulterado descartado, sem os dados, conflito de id, falha no meio).
- `e2e/data-hub.spec.ts` (Chromium, Firefox, WebKit): A — importar CSV com prévia, persistir após recarregar,
  exportar CSV seguro e JSON, substituir pelo JSON; B — malformado, grande demais e prévia cancelada sem estado
  parcial; C — Dados → Fórmula e a pergunta do backup (com e sem os dados); D — em “outro dispositivo”, backup sem os dados
  mostra “ausente” e o backup com os dados restaura sem recarregar.
- Revisão do Codex no PR #27 (3 achados, todos com teste de regressão que falhava antes): detecção do delimitador
  com mais de 200 registros na amostra; laço de despejo/recarga do cache com datasets em uso; “ausente” preso no
  cache após restaurar os dados. 2ª rodada (2 achados, também com regressão): arquivo grande só com CR e limite de
  gravação em caracteres UTF-16 × leitura em bytes UTF-8 (gravava conteúdo que não relia). 3ª rodada: exportação de
  dataset grande que não reimportava — limites alinhados, JSON compacto e ida e volta CSV exata.

## Futuro: Social Analytics Hub (fora do D2)

O Data Hub é genérico de propósito: um conector futuro (YouTube Analytics, Instagram/Facebook Insights, TikTok)
seria um **componente nativo autorizado** que obtém dados por autenticação oficial e grava conjuntos no mesmo
formato (`DatasetContent`, asset imutável), entregues aos dashboards pelas mesmas saídas limitadas. Nenhum OAuth,
token ou chamada a essas APIs existe no D2.
