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

## AI Tiles

- Logos são marcas dos respectivos titulares; o uso no app é referencial. As diretrizes da OpenAI e da xAI não puderam ser lidas durante a pesquisa (bloqueio a leitura automatizada). Antes de distribuição comercial, confirmar condições com cada titular (docs/AI_TILES.md).
- Grok não tem integração funcional (o servidor local não tem provedor xAI); o tile é só visual.
- O estado “API configurada” depende do servidor local (`/api/ai/providers`), lido uma vez por sessão; ao configurar uma chave, recarregue a página.
- O tamanho mínimo de redimensionamento é o genérico do editor (4 px); abaixo de ~24 px a logo deixa de ser legível.
- Copiar um tile vinculado para outro quadro sem o bloco de IA mantém o id antigo e mostra “Vínculo ausente” até ser religado.

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
- IA com credenciais reais não verificada (sem chave no ambiente); o contrato com cada provedor é testado com `fetch` simulado.

## Integrações não implementadas (escopo de ciclos futuros)

Google Calendar, Google Drive, GitHub, API externa, indicadores financeiros, dashboards; sincronização em nuvem; colaboração em tempo real; autenticação.
