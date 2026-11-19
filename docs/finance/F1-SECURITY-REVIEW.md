# Ciclo F1 — Revisão de segurança financeira (interna, adversarial)

Escopo: todo o diff do ciclo F1 (`src/finance/**`, `src/ui/finance/**`, `bankQuery.tsx`, `aiFinanceSuggestions.tsx`, mudanças em `aiContext.ts`, `ai.tsx`, `financePeriod.ts`, `chart.tsx`, `widgets/dataflow.ts`, `exportImport.ts`, `fileActions.tsx`, `main.tsx`, `TopBar.tsx`, `App.tsx`). Revisora: Helena (Claude Code). Data: 2026-11-19. **Não substitui** uma revisão independente.

Proteções do ciclo S1 preservadas: CSP e sandbox inalterados; nenhuma dependência nova; nenhuma requisição de rede nova (o módulo financeiro não faz `fetch`); build público continua sem `/api` e sem `window.__aurora` (o módulo financeiro só aparece em `window.__aurora.finance` nos builds com ganchos de teste); importação de quadros mantém orçamento de complexidade e gravação atômica.

## Achados e correções

| Id | Sev. | Achado | Situação | Teste |
|---|---|---|---|---|
| F1-SEC-01 | **P1** | A autorização de envio à IA ficava no JSON do quadro (`confirmedDigest`, resumo FNV público). Um quadro importado/manipulado — inclusive com o `ledgerId` real tirado de um quadro exportado — podia trazer autorização “válida” para o modo detalhado | **Corrigido**: concessões ficam só no razão local (`aiGrants`, por bloco + configuração exata + razão deste navegador); o quadro guarda só o resumo para a interface; backups não levam concessões; apagar dados as remove | `finance-canvas-ai` › autorização forjada; mudar consulta/duplicar bloco; backups |
| F1-SEC-02 | P2 | Um Mês/Fórmula/Gráfico alimentado por consulta bancária expunha totais à IA sem a autorização do bloco bancário | **Corrigido**: bloqueio por dependência (busca a montante pelas conexões de dados), revalidado no envio | › contexto desativado (Mês derivado) |
| F1-SEC-03 | P2 | Ordem da sanitização para IA: remover colchetes depois de mascarar desfazia as máscaras; o corte em 60 caracteres podia partir uma máscara | **Corrigido**: remove marcação → mascara → corta → descarta máscara cortada. Nenhum dígito vazava (verificado), mas a saída ficava ambígua | › detalhado: descrição maliciosa |
| F1-SEC-04 | P2 | Registro corrompido no IndexedDB (valor fracionário, data impossível, conta inexistente) podia quebrar telas e somas | **Corrigido**: filtro de integridade ao carregar; registro fica no disco, aviso na interface | `finance-ledger` › registros corrompidos |
| F1-SEC-05 | P3 | Teto do texto financeiro para IA ultrapassava em 3 caracteres e podia cortar uma linha no meio | **Corrigido**: corte em quebra de linha, teto exato (6.000) | › payload excessivo |
| F1-SEC-06 | P3 | Transferências apareciam como “pagamentos recorrentes” | **Corrigido** (só consumo) | — |

## Vetores verificados

| Vetor | Resultado |
|---|---|
| Dados bancários em logs | O módulo não usa `console`; teste intercepta `console.*` em operações financeiras e não encontra descrições |
| Vazamento em exportações | Backup visual sem razão (unit + E2E jornada E); backup financeiro separado, com aviso; cifra opcional AES-GCM/PBKDF2 |
| Dados financeiros no quadro compartilhável | Bloco guarda só a consulta (teste lista as chaves de `data`). **Residual**: conversas do Assistente ficam no quadro (ver abaixo) |
| Envio acidental à IA | Padrão “Nada”; concessão local por bloco/configuração; dados derivados bloqueados; prévia exata; E2E jornada F verifica o corpo enviado |
| Prompt injection por descrição | Descrições entre aspas, sem marcação, avisadas como dado; sugestões de categoria só para referências autorizadas e categorias existentes, com confirmação; nenhuma ação financeira real existe |
| CSV malicioso / injeção de fórmulas | Parser sem execução; exportação neutraliza `= + - @ \t \r` (unit + E2E jornada H) |
| OFX malformado / XXE | Tokenizador próprio; `DOCTYPE/ENTITY` recusados; limites de profundidade/nós/movimentações (unit + E2E) |
| Arquivos muito grandes | 20 MB (extratos) / 150 MB (backups) checados antes de ler; linhas/colunas/campos limitados (E2E com 21 MB) |
| Duplicação / sobrescrita | Chaves de deduplicação + recusa no repositório; conflitos não sobrescrevem; manuais intocados |
| Confusão entre contas | Aviso quando o número mascarado do arquivo difere da conta; OFX associa automaticamente pela conta mascarada |
| Ids forjados | Ids validados (`[\w-]{1,80}`) em backups e na consulta; referência a conta inexistente = indisponível |
| Saldos inconsistentes | Informado × fluxo × estimado separados; sem âncora não há saldo; consolidado diz o que falta |
| Tokens expostos | Nenhum token existe no frontend; registro de consentimento só com referência opaca (teste lista as chaves) |
| Falhas de revogação | Revogar só muda o estado local se o provedor confirmar; erro aparece; dados locais preservados |
| Erros com dados sensíveis | Mensagens genéricas de armazenamento; erros de linha citam ≤ 30 caracteres, só na tela |
| Inconsistência após falha de gravação | Gravação no disco antes da memória; falha simulada não altera o estado (unit) |
| Corrupção do IndexedDB | Filtro de integridade (F1-SEC-04); falha ao abrir mostra erro sem apagar nada |

## Riscos residuais (aceitos e documentados)

| Id | Sev. | Risco | Mitigação |
|---|---|---|---|
| R-01 | P2 | Armazenamento local **não cifrado**: quem acessa o perfil do navegador lê o razão | Documentado em FINANCIAL_PRIVACY.md; recomendação de criptografia de disco; backups podem ser cifrados. Cofre local fica para ciclo futuro |
| R-02 | P2 | Conversas do Assistente IA (perguntas e respostas, que podem citar valores) ficam salvas no quadro e vão no backup visual | Aviso no próprio bloco quando há dados bancários autorizados; recomendação de limpar a conversa antes de compartilhar |
| R-03 | P3 | Imagem PNG/SVG mostra o valor visível do bloco de consulta | Por desenho (o usuário exporta o que vê) |
| R-04 | P3 | Classificação automática por palavras-chave pode errar (ex.: PIX para terceiros vs. transferência própria) | Pareamento só com contrapartida própria e evidência; tudo editável; avisos na visão geral |
| R-05 | P3 | Mês de fatura estimado pelo dia de fechamento | Rotulado “estimado” |
| R-06 | — | Nenhuma conexão Open Finance real; segurança de um backend futuro não avaliada | Pré-requisitos em OPEN_FINANCE.md; exigir nova revisão antes de dados reais por conector |

**P0/P1 em aberto: nenhum.** Recomenda-se revalidação independente (como no ciclo S1) antes de qualquer conexão bancária real.
