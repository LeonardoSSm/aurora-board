# Persistência e integridade dos dados

## Onde os dados ficam

| Local | Conteúdo |
|---|---|
| IndexedDB `aurora-board` | `workspaces`, `boardMeta` (metadados para listagem), `boards` (quadro completo), `assets` (imagens/arquivos como data URL), `kv` (preferências e cópias de segurança) |
| localStorage `aurora-board-journal:<idDoQuadro>` | Diário de recuperação: último snapshot ainda **não confirmado** no IndexedDB |
| localStorage `aurora-board-v2-data` | Dados do protótipo v0.2/v0.3 — **nunca** apagados; importados uma vez na primeira execução |

Todas as escritas passam por `PersistenceAdapter` (`src/persistence/adapter.ts`): `IndexedDBAdapter` em produção, `MemoryAdapter` nos testes.

## Autosave com revisões (`src/persistence/autosave.ts`)

1. Cada alteração do quadro aberto (elementos, câmera, metadados) gera uma **revisão** nova: `latestRev[quadro]`.
2. Após 400 ms sem alterações (ou ao trocar de quadro, Ctrl+S, ocultar/fechar a página) o snapshot atual é:
   - escrito **de forma síncrona** no diário do quadro (`aurora-board-journal:<id>`), junto com sua revisão;
   - colocado numa **fila única** de gravações no IndexedDB.
3. Quando uma gravação termina, `savedRev[quadro]` avança **só até a revisão daquele snapshot**. Uma gravação antiga nunca confirma uma revisão mais nova.
4. O diário só é apagado quando `savedRev == latestRev` (não há nada mais novo pendente daquele quadro).
5. Indicador: **erro** (alguma gravação falhou) › **salvando** (há gravações na fila) › **pendente** (alterações ainda não enviadas) › **salvo**.
6. Falha de gravação: o snapshot fica em memória e o diário é mantido; novas tentativas automáticas em 2 s, 5 s, 15 s e depois a cada 30 s. O usuário vê um aviso (com mensagem específica para armazenamento cheio).
7. Operações fora do autosave (metadados de quadro fechado, exclusão) usam `runExclusive` — a mesma fila — para não intercalar com um snapshot antigo. Excluir um quadro descarta suas pendências (`forgetBoard`), impedindo que uma nova tentativa o recrie.

### Por que isso foi necessário (defeitos confirmados no ciclo 2)

| Defeito | Reprodução | Teste |
|---|---|---|
| Gravação antiga apagava o diário de uma alteração mais nova ainda na fila | portão de gravação: v1 em gravação, v2 enfileirada; liberar v1 apagava o diário com v2 | `persistence-stress.test.ts` › “gravação antiga NÃO apaga…” |
| Indicador “salvo” enquanto v2 ainda não estava gravada | mesmo cenário | idem |
| Diário único: falha num quadro + edição em outro sobrescrevia o diário do primeiro | falhar a gravação de A, trocar para B e editar | “falha de gravação mantém dados recuperáveis por quadro…” |
| Uma gravação travada bloqueava todas as seguintes para sempre (fila global encadeada) | portão nunca liberado | fila recriada ao trocar de adaptador; falhas não são reenviadas em laço |

## Recuperação ao abrir o app (`src/store/init.ts`)

Para cada diário encontrado (inclusive a chave única antiga `aurora-board-journal`):
- se o workspace não existe neste banco, o diário é **mantido** (não se descarta o que não se entende);
- se o diário é mais novo (ou igual) que o gravado e o conteúdo difere, ele é validado (`migrateBoard`) e gravado; o usuário recebe aviso;
- depois o diário é removido.

## Integridade ao carregar (`src/persistence/migrations.ts`)

Todo quadro — vindo de importação, do diário **ou do próprio IndexedDB** — passa por `migrateBoard`:

| Situação | Reação |
|---|---|
| Elemento que não passa no esquema | Descartado, com aviso |
| Coordenadas/tamanhos inválidos (NaN, ausentes) | Reparados com valores padrão (o elemento é mantido) |
| Id duplicado | Renomeado, com aviso |
| Seta apontando para elemento inexistente | A ponta fica solta (a seta é mantida), com aviso |
| `frameId` inexistente | Elemento sai do frame, com aviso |
| Grupo com um único membro | Grupo removido |
| Esquema mais novo que o app | Aviso; campos desconhecidos podem ser ignorados |
| Imagem cujo arquivo não existe | Placeholder “Imagem indisponível” (antes ficava “Carregando…”) |

Quando há reparos ao abrir, o quadro original é copiado **uma vez** para `kv:backup-before-repair:<id>` antes de qualquer regravação, e o usuário é avisado. Sem edição, nada é regravado.

O histórico de desfazer/refazer é só de memória (por quadro); não é persistido.

## Backups

- **Exportar → Este quadro / Backup do workspace**: JSON com quadros e arquivos referenciados.
- **Importar** é sempre **não destrutivo** (`applyImport`): quadros com id já existente recebem id novo; assets existentes não são substituídos. Um relatório mostra avisos antes de confirmar.
- Para recuperar um quadro antigo sem perder o atual: importe o backup — ele entra como um quadro novo ao lado do existente.

## Testes

`tests/unit/persistence-stress.test.ts` (adaptador com portões controlados, sem depender de tempo real): 100 alterações rápidas, edição durante gravação, troca de quadro durante autosave, fechamento com pendências, recuperação após falha e nova tentativa, quota do diário, reabertura após gravação interrompida, metadados + elementos simultâneos, quadros concorrentes, importação de 20.000 elementos.
`tests/unit/integrity.test.ts`, `tests/unit/data-protection.test.ts`: dados corrompidos e fixtures congeladas.
