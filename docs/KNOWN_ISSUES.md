# Problemas e limitações conhecidos

Estado ao final do ciclo 2. Itens marcados com ⚠ afetam uso real; os demais são limitações de escopo.

## Editor

- ⚠ **Milhares de elementos visíveis ao mesmo tempo** (ex.: enquadrar tudo num quadro de 5.000): pan/zoom ficam em 80–150 ms por quadro, limitados pela pintura do DOM/SVG. Em zoom de trabalho (recorte do viewport) é fluido. Caminho futuro: nível de detalhe com `<canvas>` em zoom distante. Medições em `docs/PERFORMANCE.md`.
- Frames não recortam visualmente os elementos de dentro (no Excalidraw recortam).
- Setas em cotovelo não desviam de obstáculos (rota ortogonal simples, respeitando lados ancorados).
- Ferramenta Imagem insere no centro da tela (no Excalidraw a imagem acompanha o cursor até o clique).
- Elementos bloqueados podem ser selecionados (para desbloquear pelo painel); no Excalidraw o clique os ignora.
- Redimensionar manualmente uma forma muito estreita pode quebrar uma palavra no meio (largura escolhida pelo usuário é respeitada); digitar ou trocar a fonte alarga a forma para não quebrar.
- Importação de arquivos `.excalidraw` não suportada.

## Navegação espacial

- Área útil dos indicadores estimada por margens fixas (barra superior, controles de zoom); um menu aberto pode cobrir um indicador temporariamente.
- Com 50–100 checkpoints, ocasionalmente um quadro perdido no pan (p95 ≈ 26–28 ms).
- Distinguir roda de touchpad continua heurístico (deslocamento horizontal ou eventos pequenos fracionários = touchpad). A classificação só decide pan × zoom no modo “Zoom” e o ganho da pinça; touchpads que enviam saltos inteiros grandes podem ser tratados como roda.
- Checkpoints não aparecem em PNG/SVG (por desenho) e não há opção de incluí-los.
- Firefox do Playwright não abre no Windows de desenvolvimento (`spawn UNKNOWN`); validado no CI.

## Finanças visuais

- Períodos só mensais; sem conversão de moedas (por desenho); sem integração bancária.
- Conexões de dados antigas (sem portas) seguem a resolução automática; o nome lógico delas vem do título atual da origem até serem religadas.
- Gráfico exportado em PNG/SVG é redesenhado em SVG com os mesmos números (aparência semelhante à tela, não idêntica).
- Com milhares de blocos financeiros, o recálculo percorre o grafo inteiro (≈4 ms com 1.000 valores); só os blocos afetados re-renderizam.
- Renomear a variável pelo painel da **conexão** não reescreve a fórmula; pelo painel da **fórmula**, reescreve.

## Finanças pessoais (ciclo F1)

- ⚠ **Meu Pluggy implementado, mas nenhuma conta real conectada ainda.** Os testes usam só uma Pluggy simulada. A primeira sincronização real deve ser conferida contra o app do banco, na prévia: sinal das movimentações de conta (a documentação só mostra em exemplos), unidade dos saldos e data das movimentações com horário (ver “Meu Pluggy” abaixo).
- ⚠ **Armazenamento financeiro local não cifrado** (IndexedDB `aurora-finance`): quem acessa o perfil do navegador lê os dados. Backups financeiros podem ser cifrados.
- Conversas do Assistente IA (que podem citar valores autorizados) ficam salvas no quadro e vão no backup visual; limpe a conversa antes de compartilhar.
- Classificação automática por palavras-chave pode errar (PIX/TED para terceiros × entre contas próprias); pares só com contrapartida própria e evidência; tudo editável.
- Mês de fatura do cartão é estimado pelo dia de fechamento; faturas eletrônicas e parcelas futuras não são lidas.
- Sem perfis de importação por banco (nenhum layout real avaliado); o mapeamento manual cobre layouts diferentes.
- Sem conversão de moedas; contas em moedas diferentes ficam fora do consolidado da outra moeda.
- O consentimento do provedor fictício vive só na memória da aba (aparece como expirado após recarregar).
- Um par conciliado automaticamente pode ficar errado se uma terceira conta com o mesmo valor for importada depois (desfaça pelo link “par”).

## Meu Pluggy (issue #9)

- A Pluggy atualiza os dados do Meu Pluggy ~1×/dia e não permite atualização forçada: “Sincronizar” traz só o que já está disponível lá.
- Uma movimentação **pendente** cancelada no banco (que some da Pluggy) continua pendente no razão. Exclua-a manualmente se for o caso.
- Renovar a autorização pode mudar o itemId. O Aurora reconhece as contas pelo tipo, instituição e final do número, mas, se houver duas contas iguais nesses critérios, nenhuma é religada automaticamente: vincule pela prévia.
- Sem vínculo com uma conta de extrato, uma movimentação que a Pluggy descreve de outro jeito que o CSV/OFX entra com alerta (mesmo valor e data próxima). Use o vínculo da prévia para começar a Pluggy depois do histórico do arquivo.
- A instituição de cada conta é deduzida do código COMPE ou do nome. Bancos fora da tabela aparecem como “Meu Pluggy”.
- Sem webhooks (o servidor local não é exposto) e sem sincronização automática: o titular sincroniza quando quiser.
- Por padrão, computadores pareados não acessam o Meu Pluggy (`AURORA_PLUGGY_PAIRED_READ=1` libera a leitura).

## HTML Data Bridge (issue #11)

- O host nunca grava entradas ou saídas, mas o **código** do HTML pode copiar entradas para `aurora.setState`, que é gravado no quadro. O painel avisa quando o bloco recebe dados bancários; revise HTML de terceiros antes de conectá-lo a uma Consulta bancária.
- Saídas ficam em memória: depois de recarregar a página, fórmulas ligadas a um HTML ficam sem valor até o bloco rodar de novo (ele roda ao aparecer na tela).
- A autorização de IA de um bloco HTML cobre a configuração, não os valores: a prévia mostra os valores do momento, e o envio usa os valores atuais (igual à Consulta bancária).
- Removido por segurança: o resumo de blocos HTML deixou de incluir até 500 caracteres do estado (que ia à IA quando o bloco era conectado). Para enviar algo à IA, declare saídas e autorize.
- A remoção das APIs de WebRTC é defesa em profundidade dentro do documento do sandbox; um navegador que exponha outro canal fora da CSP não está coberto.

## AI Tiles

- Logos são marcas dos respectivos titulares; o uso no app é referencial. As diretrizes da OpenAI e da xAI não puderam ser lidas durante a pesquisa (bloqueio a leitura automatizada). Antes de distribuição comercial, confirmar condições com cada titular (docs/AI_TILES.md).
- Grok não tem integração funcional (o servidor local não tem provedor xAI); o tile é só visual.
- O estado “API configurada” depende do servidor local (`/api/ai/providers`), lido uma vez por sessão; ao configurar uma chave, recarregue a página.
- O tamanho mínimo de redimensionamento é o genérico do editor (4 px); abaixo de ~24 px a logo deixa de ser legível.
- Copiar um tile vinculado para outro quadro sem o bloco de IA mantém o id antigo e mostra “Vínculo ausente” até ser religado.

## Smart Links (issue #22)

- Imagem enviada aceita só PNG, JPEG e WebP (até 2 MB). GIF animado e SVG ficam para um ciclo futuro (docs/SMART_LINKS.md).
- Não há favicon: a pré-visualização do servidor local só traz a imagem Open Graph, e buscar favicons no navegador contactaria terceiros. O ícone automático por domínio cobre os sites conhecidos; os demais usam o globo.
- A imagem remota “Do site” depende do site continuar servindo o mesmo endereço; se falhar, o atalho volta ao ícone. Ela nunca entra em PNG/SVG exportados.
- Ícones de marca são referenciais (marcas dos titulares; vetores do Simple Icons, CC0). Antes de distribuição comercial, revisar as diretrizes de cada marca (src/assets/link-icons/README.md).
- O nome no SVG exportado é cortado por estimativa de largura (sem medir a fonte); em nomes longos o corte pode diferir alguns caracteres do “…” da tela.
- Abrir o atalho é bloqueado pelo navegador se o clique não for reconhecido como gesto do usuário (ex.: alguns leitores de tela que disparam cliques sintéticos); o botão “Abrir link” das Propriedades funciona nesses casos.

## Persistência

- ⚠ **Diário de recuperação no `localStorage` (~5 MB)**: quadros muito grandes (> ~10.000 elementos, ~2,5 MB por 5.000) não cabem; o IndexedDB continua gravando normalmente. Se o navegador fechar no meio de uma gravação de um quadro desse tamanho, a última alteração pode se perder.
- Histórico de desfazer não é persistido (só em memória, por quadro).
- Assets (imagens/arquivos) excluídos de todos os quadros continuam no IndexedDB (não há coleta de lixo).
- Sem sincronização entre abas: duas abas editando o mesmo quadro sobrescrevem uma à outra (a última gravação vence).

## Segurança

- Servidor local sem autenticação: protegido contra sites visitados (Host/Origin/Content-Type), não contra outros processos da mesma máquina.
- Permissões declaradas por plugins são informativas; o isolamento vem do sandbox/CSP.
- O widget “HTML isolado” guarda HTML no quadro. Desde o ciclo S1, HTML **importado ou colado** entra desativado até o usuário ativá-lo; depois de ativo, roda isolado e sem rede, mas pode exibir conteúdo enganoso. Widgets importados antes do S1 não têm essa marcação (tratados como locais).
- **Prévia de PDF desativada** (S1): PDFs só podem ser baixados. Voltará quando houver prévia isolada validada nos três navegadores.
- Imagens com dimensões acima de 100 MP / 30 000 px não são exibidas (proteção contra bomba de descompressão); o arquivo continua salvo. JPEGs cujas dimensões não aparecem nos primeiros 4 MB são exibidos sem essa checagem.
- Imagens remotas em notas e prévias de links só carregam por clique (privacidade).
- Importação recusa arquivos acima do orçamento de complexidade (ver `docs/SECURITY.md`); um backup legítimo maior que os tetos precisa ser dividido (exportar quadros separadamente). Nada é truncado.
- Navegação do frame de um widget HTML para outra origem: bloqueada em todos os navegadores; no Firefox o bloqueio não gera aviso visual (o frame simplesmente não navega).
- Laço de CPU dentro de um widget HTML ativo não travou a aba em Chromium/WebKit (frames isolados); não medido no Firefox. Recuperação: `?safe` na URL.
- CSP do build público validada só localmente (`vite preview`) e na CI; falta homologação numa hospedagem real (ver `docs/security/S1-RELEASE-CHECKLIST.md`).
- As actions do GitHub fixadas na major v4 rodam em Node 20 forçado para 24 (aviso do GitHub); a atualização de major chega por Dependabot e deve ser revisada.

## Testes e ambiente

- Firefox do Playwright não inicia no Windows de desenvolvimento usado (`browserType.launch: spawn UNKNOWN`) — infraestrutura; roda e passa no CI (Linux). Ciclo S1: persiste mesmo após `playwright install --force firefox` (o Windows bloqueia o executável não assinado).
- WebKit: atalhos sintéticos de copiar/colar não disparam eventos de área de transferência (teste pulado nesse navegador; o recurso é coberto no Chromium/Firefox).
- WebKit: o `dragTo` do Playwright não conclui arrastar-e-soltar HTML5 nativo; no teste dos AI Tiles, nesse navegador, a sequência `dragstart → dragover → drop` é disparada com um `DataTransfer` real (o arrasto nativo é coberto no Chromium/Firefox).
- WebKit local (Windows): `editing.spec.ts` › histórico de desfazer por quadro falha de forma intermitente porque o painel de quadros às vezes continua aberto após o clique e captura o Ctrl+Z. Reproduzido também no commit do ciclo 5 (`709f0dc`) — preexistente, não relacionado ao S1; passa na CI.
- Chromium headless não cria seleção de texto por arrasto sintético; o teste verifica a seleção nativa por duplo clique (o arrasto foi verificado manualmente no Chromium real).
- IA com credenciais reais não verificada (sem chave no ambiente); o contrato com cada provedor é testado com `fetch` simulado. As ações da IA (contrato v2) foram verificadas manualmente só com OpenAI `gpt-4.1-mini` (bloco de receita e lançamento em Finanças); Gemini e Anthropic não foram testados com chave real. Respostas fora do contrato são recusadas e o pedido financeiro inequívoco é coberto pela interpretação local.
- Windows local: com a suíte unitária inteira em paralelo e o `npm run dev` aberto, `security.test.ts` e `server-hardening.test.ts` (servidores HTTP de teste) falham de forma intermitente sem mensagem (2 de ~20 execuções no ciclo das ações da IA); isolados passam sempre. Não reproduzido na CI (Linux).

## GIFs animados (ciclo 6)

- Pausar mostra o **primeiro quadro** (um `<img>` não congela no quadro atual).
- PNG/SVG exportam o primeiro quadro; exportar o quadro como GIF/vídeo não existe.
- GIFs que o leitor não entende (malformados ou com mais de 10.000 quadros) ficam por conta do navegador: sem repetição forçada, pausa ou prévia estática.
- Retomar a animação ao voltar à tela (em vez de reiniciar) é comportamento do navegador, verificado no Chromium; não é garantido por especificação.
- Firefox: o teste de **colar** GIF se pula sozinho, porque eventos de colar criados por script não carregam arquivos nesse navegador (visto na CI). Colar é coberto no Chromium e no WebKit; o caminho de inserção é o mesmo do seletor e do arrastar-e-soltar, testados nos três.

## Integrações não implementadas (escopo de ciclos futuros)

Google Calendar, Google Drive, GitHub, API externa, indicadores financeiros, dashboards; sincronização em nuvem; colaboração em tempo real; autenticação.

## CI (ciclo CI-1, #25)

- Os testes de navegador rodam na imagem `mcr.microsoft.com/playwright:v1.65.1-noble` (fixada por digest), baixada do MCR a cada job (~1 GB comprimido). Uma degradação do MCR ainda pode atrasar um job; o tempo aparece em "Initialize containers". O travamento original (apt do WebKit a ~50 kB/s) deixou de ser possível porque nada é instalado via apt.
- Subir o `@playwright/test` exige atualizar a tag e o digest da imagem nos jobs `e2e` e `static`; `tests/unit/ci-workflow.test.ts` e o passo "Navegadores da imagem" falham enquanto divergirem (procedimento em `docs/DEVELOPMENT.md`).

## Data Hub (issue #24, D2-A)

- Importação de planilhas `.xlsx` não é suportada: salve como “CSV UTF-8”. Outras codificações (Latin-1/Windows-1252) são recusadas com orientação.
- Textos que parecem fórmula saem no CSV com `'` na frente (proteção para planilhas); ao reimportar esse CSV, o `'` permanece no texto.
- Excluir um bloco de dados não apaga o arquivo local (como imagens), para o desfazer funcionar; apagar de fato é pelo painel do bloco (“Excluir dados deste dispositivo”). Arquivos sem referência não são coletados automaticamente.
- A IA não recebe dados importados nem derivados deles neste estágio; o consentimento granular é do D2-C.
