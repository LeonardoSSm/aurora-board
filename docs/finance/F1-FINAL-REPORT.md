# Ciclo F1 — Relatório final (Personal Finance Hub & Open Finance Foundation)

Responsável: Helena (Claude Code) · Data: 2026-11-20 · Branch: `feature/personal-finance-hub-f1` · Issue: [#8](https://github.com/LeonardoSSm/aurora-board/issues/8) · Base: `main@fe08795`.

## A. Resumo executivo

O Aurora Board passou a administrar finanças pessoais **localmente**: contas e cartões, importação de extratos CSV/OFX com prévia e confirmação, deduplicação idempotente, conciliação de transferências e faturas, categorias e regras, histórico com reversão, visão consolidada, integração com o canvas (bloco **Consulta bancária**), análise por IA **somente com autorização explícita**, backups financeiros separados (com cifra opcional) e a fundação de conectores Open Finance com um provedor **fictício** completo. **Nenhuma conta bancária real foi conectada**; não há integração Open Finance real.

Fora do escopo original, a pedido do proprietário no mesmo período: **pareamento de computadores da rede local** para usar a IA do computador principal (opcional, com token por dispositivo; ver `docs/SECURITY.md`).

## B. Auditoria inicial

Ver [F1-ARCHITECTURE-AUDIT.md](F1-ARCHITECTURE-AUDIT.md). Baseline: tipos ✅, 509 unitários ✅, build ✅, auditorias 0 vulnerabilidades, E2E Chromium 64/65 (falha preexistente `acceptance › 19`, causada pelo `.env` local). Decisões principais: banco IndexedDB **separado** (`aurora-finance`) sem tocar no esquema dos quadros; centavos com sinal da conta; classificação local separada do registro original; parser OFX próprio; cifra apenas nos backups.

## C. Dados financeiros

Modelo em `src/finance/model.ts` (instituição, conta, cartão, transação, sessão de importação, consentimento, categoria, regra). Persistência atômica com índices por conta/data/importação/deduplicação, limites de armazenamento, filtro de integridade na carga e reversão de importação. `FINANCE_SCHEMA_VERSION = 1`; `SCHEMA_VERSION` dos quadros inalterado (3). Nenhuma migração destrutiva. Detalhes: [PERSONAL_FINANCE.md](PERSONAL_FINANCE.md).

## D. Importação

CSV (RFC 4180, UTF-8/BOM ou Windows-1252, delimitador detectado, cabeçalho com preâmbulo, sinônimos pt/en, crédito/débito separados, vírgula ou ponto decimal por arquivo, datas BR/ISO/OFX, linhas de saldo ignoradas, mapeamento manual, inverter sinal) e OFX 1.x SGML / 2.x XML (conta e cartão, FITID, saldo informado; recusa `DOCTYPE/ENTITY`, extratos não bancários e moedas fora de BRL/USD/EUR). Limites de tamanho, linhas, colunas, profundidade. Exportação CSV com proteção contra injeção de fórmulas. Sem perfis por banco (nenhum layout real avaliado). Detalhes: [BANK_IMPORT.md](BANK_IMPORT.md).

## E. Conciliação

Chave por ID da fonte ou impressão digital + ocorrência no arquivo; valor + data nunca excluem sozinhos; conflitos não sobrescrevem; pendente → contabilizada atualiza sem duplicar; manuais intocados. Pares de transferência/fatura só automáticos quando únicos e com evidência textual. Transferências, faturas e aplicações fora do resultado; estornos reduzem consumo. Saldo informado × fluxo × estimado separados; consolidado declara contas sem âncora. Exemplo obrigatório: receita **R$ 2.000,00**, consumo líquido **R$ 250,00** (unitário + E2E). Detalhes: [RECONCILIATION.md](RECONCILIATION.md).

## F. Interface

“Minhas contas” (barra superior), na identidade Dark Tech: Visão geral (mês navegável, receitas, despesas, resultado, comprometimento, transferências, faturas, tarifas, saldos por conta com origem e “desatualizado”, consolidado com completude, categorias, recorrências), Contas, Cartões (faturas estimadas, limites informados), Transações (filtros, classificação, pares sugeridos, lançamento manual, CSV), Importações (histórico e reversão), Conectores (ambiente de testes rotulado), Regras e categorias, Privacidade e backups. Estados vazios orientados; nada gravado antes de confirmar.

## G. Canvas

Bloco `aurora.bank-query` (Receitas/Despesas/Saldo do banco) com saídas `money` (com `members`), `finance.occurrences` (chaves `bank:tx:<id>`) e `finance.periods`. Contratos existentes preservados por campos opcionais (`Occurrence.key`, `MoneyValue.members`; Gráfico aceita `finance.periods`). O Mês recusa contagem dupla entre conexões e agregados de vários meses; estornos reduzem despesa. Mudanças no razão recalculam o fluxo (versão externa no memo do dataflow). O quadro guarda só a consulta; outro navegador mostra “indisponível”.

## H. IA

Privado por padrão: modo *Nada* / *Resumo agregado* / *Movimentações*, prévia do texto exato, **autorização local** por bloco + configuração + razão do navegador (não vem do quadro — correção do P1 F1-SEC-01), bloqueio de dados derivados, descrições como dados não confiáveis (mascaradas, entre aspas), referências opacas, teto de 6.000 caracteres. Sugestões de categoria só para referências autorizadas e categorias existentes, com confirmação. Nenhuma ação financeira real existe. Detalhes: [FINANCIAL_PRIVACY.md](FINANCIAL_PRIVACY.md).

## I. Open Finance

Contrato `BankDataProvider` somente leitura; sincronização pelo mesmo planejador de importação; estados de conexão completos; provedor fictício com duas instituições, duas contas, cartão, pendente, duplicata, expiração, falhas e revogação. **Sandbox externo não usado** (Pluggy/Belvo exigem credenciais de aplicação e backend; nenhuma fornecida; nenhum cadastro feito). Pesquisa, custos e caminho para conexão real: [OPEN_FINANCE.md](OPEN_FINANCE.md).

## J. Segurança

Revisão adversarial em [F1-SECURITY-REVIEW.md](F1-SECURITY-REVIEW.md): 1 P1 (autorização de IA forjável no quadro) e 4 P2/P3 corrigidos com testes. **Nenhum P0/P1 aberto.** Riscos residuais: armazenamento local não cifrado; conversas da IA salvas no quadro (aviso no bloco); valores visíveis em PNG/SVG; heurísticas de classificação. Proteções do S1 preservadas (CSP, sandbox, build público sem `/api`/`__aurora`, nenhuma dependência nova). Recomenda-se revalidação independente antes de qualquer conector real.

## K. Testes

| Suíte | Resultado |
|---|---|
| Unitários (total) | **598/598** ✅ (509 → 598; +80 finanças em 4 arquivos, +9 pareamento) |
| E2E finanças `e2e/finance.spec.ts` (jornadas A–H) | Chromium 8/8 ✅ local; CI ✅ em Chromium, Firefox, WebKit |
| E2E completo Chromium + mobile (local) | 76/77 — única falha `acceptance › 19`, preexistente (`.env` local com chaves) |
| CI (`454ead1` e `cdf62cb`) | 12/12 jobs ✅ (tipos, unitários, build público, auditoria, gitleaks, E2E ×4, build+CSP ×3) |
| Auditoria de dependências | 0 vulnerabilidades (nenhuma dependência adicionada) |

Local: Firefox não executa nesta máquina (preexistente); duas jornadas no WebKit local falharam durante uma execução em que arquivos eram editados (recarga do dev server) e passaram na CI.

## L. Performance

`npm run perf:finance` — build de produção com ganchos, Chromium, IndexedDB real, i5-1135G7 (`perf-results/financas-razao.json`). Tempos em ms.

| Movimentações | Ler CSV | Planejar | Gravar | Reimportar (100% duplicadas) | Consulta do canvas | Resumo | Recalcular quadro | Abrir “Minhas contas” | Filtrar | Heap |
|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 5 | 1 | 13 | 1 | 2 | 0,2 | 34 | 104 | 35 | 8 MB |
| 1.000 | 10 | 3 | 110 | 2 | 0,4 | 0,3 | 14 | 37 | 137 | 15 MB |
| 10.000 | 54 | 21 | 1.210 | 21 | 1,3 | 2,4 | 37 | 69 | 189 | 38 MB |
| 50.000 | 309 | 164 | 6.268 | 139 | 19 | 39 | 50 | 105 | 180 | 92 MB |

Gargalo demonstrado e corrigido: a gravação aguardava duas idas ao IndexedDB por movimentação (50 mil: **19,6 s**; 10 mil: 4,2 s). Agora as requisições vão em lote dentro da mesma transação atômica: **6,3 s** e 1,2 s. Abrir e filtrar ficam em ~0,1–0,2 s até 50 mil (tabela limitada a 200 linhas por página). “Filtrar” inclui a latência do Playwright. Efeito em quadros grandes: o recálculo com uma consulta bancária fica em dezenas de ms; quadros sem consulta bancária só recalculam quando o razão muda.

## M. GitHub

Branch `feature/personal-finance-hub-f1` com commits incrementais por etapa (auditoria → domínio/persistência → importação/conciliação → backups/provedores → canvas/IA → interface → segurança/E2E/docs → pareamento → desempenho/relatório). CI verde. Merge na `main` com `--no-ff` após este relatório. Nenhum deploy público.

## N. Pendências

Para usar contas bancárias **reais** por conector:
1. Contratar intermediário (ou confirmar por escrito as condições do “Meu Pluggy” para uso pessoal).
2. Backend seguro com credenciais, webhooks, autenticação e retenção mínima.
3. Adaptador `BankDataProvider` falando só com esse backend; testes no sandbox oficial.
4. Consentimento real com autorização explícita do titular; nova revisão de segurança.

Também em aberto: cofre cifrado para o armazenamento local; perfis de importação a partir de extratos reais avaliados localmente; leitura de faturas eletrônicas; Gemini/Anthropic com chave real (do ciclo anterior); revalidação independente.

## O. Recomendações (maior valor para uso pessoal)

1. Importar 2–3 meses dos seus extratos reais (CSV/OFX) e ajustar regras de categoria — o ganho imediato.
2. Perfis de importação para os seus bancos, criados a partir desses arquivos (sem versioná-los).
3. Orçamento por categoria com alertas no canvas (Consulta bancária + Fórmula já cobrem o cálculo).
4. Cofre local cifrado opcional (desbloqueio por sessão) quando o fluxo de uso estiver estável.
5. Avaliar o “Meu Pluggy” com o titular antes de qualquer contrato pago.
