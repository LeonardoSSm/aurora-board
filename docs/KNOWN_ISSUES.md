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
- O widget “HTML isolado” guarda HTML no quadro: importe quadros apenas de fontes confiáveis (o HTML roda isolado e sem rede).

## Testes e ambiente

- Firefox do Playwright não inicia no Windows de desenvolvimento usado (`browserType.launch: spawn UNKNOWN`) — infraestrutura; roda e passa no CI (Linux).
- WebKit: atalhos sintéticos de copiar/colar não disparam eventos de área de transferência (teste pulado nesse navegador; o recurso é coberto no Chromium/Firefox).
- WebKit: o `dragTo` do Playwright não conclui arrastar-e-soltar HTML5 nativo; no teste dos AI Tiles, nesse navegador, a sequência `dragstart → dragover → drop` é disparada com um `DataTransfer` real (o arrasto nativo é coberto no Chromium/Firefox).
- Chromium headless não cria seleção de texto por arrasto sintético; o teste verifica a seleção nativa por duplo clique (o arrasto foi verificado manualmente no Chromium real).
- IA com credenciais reais não verificada (sem chave no ambiente); o contrato com cada provedor é testado com `fetch` simulado.

## Integrações não implementadas (escopo de ciclos futuros)

Google Calendar, Google Drive, GitHub, API externa, indicadores financeiros, dashboards; sincronização em nuvem; colaboração em tempo real; autenticação.
