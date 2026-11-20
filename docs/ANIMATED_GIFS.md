# GIFs animados no canvas (ciclo 6)

GIFs são imagens comuns do Aurora Board: entram pela ferramenta **Imagem**, arrastando o arquivo, colando da área de transferência ou por importação de backup JSON, e se movem, redimensionam, agrupam, bloqueiam, duplicam e desfazem como qualquer imagem. O que muda é a **animação**: ela roda dentro do retângulo da imagem enquanto você edita o resto do quadro.

## Auditoria do comportamento nativo (antes de mudar qualquer coisa)

Feita no Chromium com GIFs sintéticos (um com repetição infinita, outro sem extensão de repetição):

| Pergunta | Resultado observado |
|---|---|
| O `<img>` do canvas anima um GIF? | Sim — o GIF com repetição alternou quadros continuamente |
| GIF sem extensão de repetição | Tocou uma vez e **parou no último quadro** (comportamento padrão dos navegadores) |
| Sair da tela e voltar (o canvas desmonta o que está fora da vista) | Com a **mesma URL**, o navegador **retoma** a animação de onde estava — não reinicia do primeiro quadro |
| Medir a animação pelo `<canvas>` 2D | Impossível: pela especificação HTML, `drawImage` usa sempre o primeiro quadro de um GIF. Os testes usam capturas de tela do elemento |

Conclusões: o pipeline de assets não precisava ser reescrito nem um widget novo criado. Faltavam a repetição contínua para GIFs finitos, controle de reprodução, respeito ao movimento reduzido e exportação estática determinística. E as URLs de exibição precisam ser **estáveis por arquivo** para não introduzir reinícios ao navegar.

## Comportamento

| Situação | Exibição |
|---|---|
| Padrão (reprodução **Automático**, repetição **Repetir sempre**) | Anima e repete para sempre, mesmo que o arquivo diga “tocar uma vez” |
| Repetição **Como no arquivo** | Respeita a extensão do GIF (uma vez, N repetições ou infinito) |
| Reprodução **Pausar** | Primeiro quadro, com selo “GIF ⏸” |
| Reprodução **Reproduzir** | Anima mesmo com movimento reduzido ou preferência “Nunca” |
| Preferência geral **Sistema** (padrão) + movimento reduzido ativado no SO | Primeiro quadro com selo, até você escolher Reproduzir no GIF |
| Preferência geral **Sempre** / **Nunca** | Anima / para todos os GIFs em “Automático” |
| GIF pesado (largura × altura × quadros > 400 milhões de pixels) | Fica parado, com aviso — proteção de memória |

- **Pausar mostra o primeiro quadro**: um `<img>` não permite congelar com precisão no quadro atual; não prometemos isso.
- Controles: selecione o GIF → painel **Propriedades → GIF animado** (quadros, duração do ciclo, repetição no arquivo). Preferência geral: sem seleção → **Animações (GIF)**, abaixo da sensibilidade do zoom. Vale para todos os quadros e fica salva.
- Mudar reprodução/repetição é uma entrada de histórico (Ctrl+Z desfaz).

## Arquivo original preservado

- O asset salvo (IndexedDB, backup JSON, cópia/colagem, duplicação) é **sempre o arquivo original**, byte a byte: frames, duração e repetição intactos.
- As variantes de exibição (repetição infinita e primeiro quadro) são calculadas na memória, uma vez por arquivo (`src/canvas/gifDisplay.ts`), e reutilizadas por todas as cópias e montagens.
- A repetição infinita é feita inserindo (ou ajustando) a extensão padrão `NETSCAPE2.0` com contador 0; os dados dos quadros não são recodificados.
- No elemento, só a escolha do usuário: `animation: { playback: 'auto'|'play'|'pause', loop: 'infinite'|'original' }` — campo **opcional** (ausente = padrão). `SCHEMA_VERSION` não mudou; quadros antigos continuam válidos; valor inválido num backup volta ao padrão em vez de descartar a imagem.

## Exportação

| Formato | Resultado |
|---|---|
| Backup JSON (quadro ou workspace) | GIF original animado, byte a byte |
| SVG | **Primeiro quadro** (estático, determinístico — duas exportações são idênticas) |
| PNG | **Primeiro quadro** (estático) |
| GIF/vídeo do quadro | Fora do escopo (ciclo separado) |

## Segurança e limites

- O formato vem dos **bytes** (`GIF87a`/`GIF89a`), não da extensão nem do tipo declarado; dimensões checadas pelos limites do S1 (100 MP, 30.000 px) e tamanho por asset de 25 MB.
- O leitor de estrutura (`src/core/gif.ts`) não decodifica pixels, checa limites em todo acesso e trata arquivos truncados/corrompidos como inválidos (teste com todos os prefixos e 2.000 corrupções aleatórias). Mais de 10.000 quadros = não lido (exibido como o navegador decidir, sem variantes).
- Nenhuma requisição de rede; as variantes são `data:` URLs (já permitidas pela CSP).

## Desempenho

Ver a tabela em [PERFORMANCE.md](PERFORMANCE.md#gifs-animados-ciclo-6) (`e2e/perf/gifs.perf.ts`).

## Testes

- `tests/unit/gif.test.ts` — leitura, duração, repetição, primeiro quadro, robustez, decisão de exibição, normalização na importação, preservação no backup.
- `e2e/gifs.spec.ts` — seletor de arquivos, arrastar-e-soltar e colar (colar no Chromium e WebKit; o Firefox não entrega arquivos em eventos de colar sintéticos), animação por capturas sucessivas, repetição contínua × “como no arquivo”, pausar/desfazer, movimento reduzido, preferência geral persistente, duplicar/redimensionar/agrupar/recarregar, exportação SVG determinística + PNG + JSON, 24 GIFs com pan/zoom e saída/volta da tela, arquivo inválido.
- Detecção de animação nos E2E: capturas do elemento com esperas **aleatórias** (40–200 ms) até a primeira diferença, janela de 6 s. Intervalos fixos davam falso “parado” no WebKit (cada captura caía na mesma fase do ciclo de 400 ms, e o WebKit avança quadros de forma irregular sob carga). Para provar que está parado, a janela é explícita e todas as capturas precisam ser iguais. Antes de recarregar, o teste da preferência geral espera a gravação chegar ao IndexedDB.
- GIFs de teste gerados por `tests/fixtures/gifEncoder.ts` (código e conteúdo do projeto; sem imagens de terceiros).

## Limitações

- Pausa = primeiro quadro (não o quadro atual).
- Exportar o quadro como GIF/vídeo não existe.
- GIFs que o leitor não entende (malformados, > 10.000 quadros) ficam a cargo do navegador: sem repetição forçada, pausa nem prévia estática.
- A retomada da animação ao voltar à tela é comportamento do navegador (verificado no Chromium); não há garantia formal de especificação.
