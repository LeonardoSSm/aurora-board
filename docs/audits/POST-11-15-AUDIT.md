# Auditoria pós-implementação #11–#15 (2026-11-20)

Branch `fix/post-11-15-audit`. Escopo: corrigir os apontamentos do Codex e auditar a integração entre HTML Data Bridge (#11), navegação espacial (#12), Aurora Wheel (#15), Command Center (#14) e AI Companions (#13). Nenhuma funcionalidade nova; nenhum formato de dados alterado.

## Problemas encontrados e corrigidos

| # | Origem | Problema | Causa | Correção | Regressão |
|---|---|---|---|---|---|
| 1 | Codex P2, PR #19 | Parar não cancelava durante a descoberta do provedor; trocar de quadro/excluir o assistente nesse intervalo ainda enviava o pedido (e o estado era recriado) | `AbortController` criado só depois de `await fetchAIStatus()`; sem identidade do pedido | Controlador criado antes de qualquer espera e usado como identidade; descoberta e envio abortáveis; antes de enviar e de gravar: pedido atual, não cancelado, mesmo quadro, assistente existe; pedido abandonado não recria estado | 7 testes em `ai-chat.test.ts` (6 falhavam no código antigo) |
| 2 | Codex P2, PR #19 | Delete com a conversa completa aberta excluía o assistente selecionado atrás; Esc não fechava | Diálogo nunca recebia o foco; `useKeyboard` não considerava `companionFull` modal | `useModalFocus` (foco inicial, Tab contido, foco perdido volta, restauração com substituto); guarda modal ampliado (`companionFull`, Command Center, captura, checkpoint, qualquer `[aria-modal="true"]`) | E2E J em `ai-companions.spec.ts` (falha no código antigo) |
| 3 | Achado do E2E J (WebKit) | Backspace com o foco num botão do diálogo voltava a página (perdia o quadro aberto) | Fora do canvas ninguém fazia `preventDefault` do Backspace | Modal e guarda global impedem Backspace fora de campo | E2E J (WebKit) |
| 4 | Codex P2, PR #16 | Viagem com centro quase parado e grande mudança de zoom congelava e “teleportava” | `ln(√(b²+1) − b)` cancela para b grande → comprimento infinito e NaN | Forma estável `−asinh(b)` | 4 casos em `navigation-motion.test.ts` (2 falhavam) |
| 5 | Codex, PR #18 | Notas: resto de URLs (ex.: `access_token=…`) pesquisável e visível no trecho | Pontuação trocada por espaço antes de remover a URL | URLs removidas inteiras primeiro (qualquer esquema, `mailto:`, `data:`, `www.`) | 7 casos em `search.test.ts` (todos falhavam) |
| 6 | Codex, PR #18 | Desfazer/refazer edição antiga do Inbox apagava o item capturado com ele fechado (e o autosave gravava a perda) | Histórico retido do quadro não conhecia a escrita externa | `rebaseHistoryWith`: o item entra em todos os retratos retidos | `command-center.test.ts` (falhava) |
| 7 | Codex, PR #18 | A→B carregando e o usuário escolhe resultado em A: a abertura antiga de B vencia | O token suprimia só o foco antigo, não a navegação | `openBoard` com geração — a última navegação vence; `jumpTo` sempre passa por `openBoard`; quadro e workspace nunca divergem | 2 testes em `command-center.test.ts` |

## Auditoria de integração (sem defeitos novos além dos acima)

- **#11 × #13:** a IA (clássico, personagem, dock) só envia por `sendAIMessage`; `financialTaint` bloqueia valores derivados de Consulta bancária ou de saídas HTML sem concessão local, também quando passam por blocos HTML. O sandbox só recebe dados bancários por conexão explícita, com aviso.
- **#14:** IA, HTML e finanças continuam indexados só pelo título; o índice só existe em memória.
- **#12 × #14 × #13:** abrir quadro cancela a animação da câmera e aborta pedidos de IA pendentes; foco no resultado usa a viagem da #12.
- **#15 × modais:** `W` e os atalhos do quadro não agem com diálogos modais abertos; o Command Center não abre com a roda aberta.
- **Dados:** nenhum campo novo em quadros/backups; `SCHEMA_VERSION` inalterado; o rebase do histórico é só em memória.

## Riscos restantes

- Command Center e Captura rápida já focam o campo e bloqueiam atalhos (agora também pelo guarda global), mas não contêm o Tab como a conversa completa. Recomendação: aplicar `useModalFocus` a todos os diálogos no próximo ciclo.
- Ctrl+Z durante um pedido pendente pode desfazer a pergunta do usuário; a resposta ainda é gravada (comportamento do desfazer, não perda de dados).
- Firefox não executa localmente nesta máquina (binário bloqueado); coberto pela CI.
