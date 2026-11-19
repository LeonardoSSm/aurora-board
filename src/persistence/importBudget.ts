/**
 * Orçamento de complexidade da importação (ciclo S1 — S1-SEC-004/005).
 *
 * Executado logo após o `JSON.parse` e ANTES da validação/migração completas, em uma única passada barata
 * sobre a estrutura bruta. Rejeita cargas claramente abusivas sem gastar tempo saneando-as.
 *
 * Os limites preservam quadros legítimos grandes (100 000 elementos por quadro continuam aceitos, como no
 * ciclo 5); o que muda é que agora existem tetos AGREGADOS e estruturais. Nada é truncado em silêncio: um
 * arquivo acima do orçamento é recusado inteiro, com a causa, e nenhum dado é alterado.
 */

export const IMPORT_LIMITS = {
  /** Tamanho do arquivo (checado por `File.size`, antes da leitura). */
  maxFileBytes: 200 * 1024 * 1024,
  maxBoards: 500,
  maxElementsPerBoard: 100_000,
  maxTotalElements: 300_000,
  /** Pontos de uma linha/seta ou desenho livre. */
  maxPointsPerElement: 50_000,
  maxTotalPoints: 3_000_000,
  /** Caracteres de texto por campo e somados (texto de elementos, títulos, dados textuais de widgets). */
  maxStringChars: 2_000_000,
  maxTotalStringChars: 120_000_000,
  /** Profundidade de objetos/arrays dentro de dados de widgets e configurações. */
  maxDepth: 48,
  /** Nós (objetos + arrays + valores) dentro dos dados de UM widget. */
  maxWidgetNodes: 200_000,
  /** Widgets HTML (conteúdo ativo) por arquivo e tamanho do HTML. */
  maxHtmlWidgets: 200,
  maxHtmlChars: 500_000,
  maxTotalHtmlChars: 5_000_000,
  maxAssets: 5_000,
  /** Comprimento de um data URL (≈ 25 MB de arquivo em base64, mesmo limite dos anexos locais). */
  maxAssetDataURLChars: 36_000_000,
  maxTotalAssetChars: 190_000_000,
} as const;

export type ImportLimits = { -readonly [K in keyof typeof IMPORT_LIMITS]: number };

export class ImportBudgetError extends Error {}

const SANDBOX_TYPE = 'aurora.sandbox-html';

const fmt = (n: number) => n.toLocaleString('pt-BR');

export interface BudgetStats {
  boards: number;
  elements: number;
  points: number;
  htmlWidgets: number;
  assets: number;
  assetChars: number;
}

/**
 * Percorre `value` iterativamente (sem recursão — não estoura a pilha com aninhamento profundo).
 * Conta nós, profundidade e caracteres; lança ao primeiro limite excedido.
 */
function walk(value: unknown, where: string, lim: ImportLimits, acc: { chars: number }, maxNodes: number) {
  const stack: [unknown, number][] = [[value, 1]];
  let nodes = 0;
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    nodes++;
    if (nodes > maxNodes) throw new ImportBudgetError(`${where}: dados com mais de ${fmt(maxNodes)} itens.`);
    if (typeof v === 'string') {
      if (v.length > lim.maxStringChars) throw new ImportBudgetError(`${where}: texto com ${fmt(v.length)} caracteres (limite ${fmt(lim.maxStringChars)}).`);
      acc.chars += v.length;
      continue;
    }
    if (!v || typeof v !== 'object') continue;
    if (depth > lim.maxDepth) throw new ImportBudgetError(`${where}: estrutura aninhada demais (mais de ${lim.maxDepth} níveis).`);
    if (Array.isArray(v)) { for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], depth + 1]); }
    else for (const k in v) if (Object.prototype.hasOwnProperty.call(v, k)) { acc.chars += k.length; stack.push([(v as Record<string, unknown>)[k], depth + 1]); }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Checa o orçamento do formato atual (`format: 'aurora-board'`). Custo: uma passada sobre os elementos.
 * Retorna estatísticas usadas na confirmação da importação.
 */
export function checkImportBudget(data: unknown, lim: ImportLimits = IMPORT_LIMITS): BudgetStats {
  if (!isObj(data)) throw new ImportBudgetError('Arquivo sem objeto raiz.');
  const boards = data.boards;
  if (!Array.isArray(boards)) return { boards: 0, elements: 0, points: 0, htmlWidgets: 0, assets: 0, assetChars: 0 };
  if (boards.length > lim.maxBoards) throw new ImportBudgetError(`Arquivo com ${fmt(boards.length)} quadros excede o limite de ${fmt(lim.maxBoards)}.`);
  const acc = { chars: 0 };
  let elements = 0, points = 0, htmlWidgets = 0, htmlChars = 0;
  for (const b of boards) {
    if (!isObj(b)) continue;
    const name = typeof b.name === 'string' ? b.name.slice(0, 60) : 'sem nome';
    for (const f of ['name', 'description'] as const) {
      const s = b[f];
      if (typeof s === 'string') { if (s.length > lim.maxStringChars) throw new ImportBudgetError(`Quadro "${name}": campo ${f} grande demais.`); acc.chars += s.length; }
    }
    if (b.settings !== undefined) walk(b.settings, `Quadro "${name}" (configurações)`, lim, acc, 1_000);
    if (b.checkpoints !== undefined) walk(b.checkpoints, `Quadro "${name}" (checkpoints)`, lim, acc, 200_000);
    const els = b.elements;
    if (!Array.isArray(els)) continue;
    if (els.length > lim.maxElementsPerBoard) throw new ImportBudgetError(`Quadro "${name}" tem ${fmt(els.length)} elementos (limite ${fmt(lim.maxElementsPerBoard)} por quadro).`);
    elements += els.length;
    if (elements > lim.maxTotalElements) throw new ImportBudgetError(`O arquivo tem mais de ${fmt(lim.maxTotalElements)} elementos no total.`);
    for (const e of els) {
      if (!isObj(e)) continue;
      const pts = e.points;
      if (Array.isArray(pts)) {
        if (pts.length > lim.maxPointsPerElement) throw new ImportBudgetError(`Quadro "${name}": elemento com ${fmt(pts.length)} pontos (limite ${fmt(lim.maxPointsPerElement)}).`);
        points += pts.length;
        if (points > lim.maxTotalPoints) throw new ImportBudgetError(`O arquivo tem mais de ${fmt(lim.maxTotalPoints)} pontos de desenho/linhas.`);
      }
      for (const f of ['text', 'title', 'widgetType', 'id', 'type'] as const) {
        const s = e[f];
        if (typeof s === 'string') {
          if (s.length > lim.maxStringChars) throw new ImportBudgetError(`Quadro "${name}": texto de elemento grande demais (${fmt(s.length)} caracteres).`);
          acc.chars += s.length;
        }
      }
      if (e.style !== undefined) walk(e.style, `Quadro "${name}" (estilo)`, lim, acc, 200);
      if (e.groupIds !== undefined) walk(e.groupIds, `Quadro "${name}" (grupos)`, lim, acc, 1_000);
      if (e.connection !== undefined) walk(e.connection, `Quadro "${name}" (conexão)`, lim, acc, 200);
      if (e.type === 'widget' && e.data !== undefined) {
        if (e.widgetType === SANDBOX_TYPE && isObj(e.data) && typeof e.data.html === 'string') {
          htmlWidgets++;
          if (htmlWidgets > lim.maxHtmlWidgets) throw new ImportBudgetError(`O arquivo tem mais de ${fmt(lim.maxHtmlWidgets)} widgets HTML.`);
          if (e.data.html.length > lim.maxHtmlChars) throw new ImportBudgetError(`Quadro "${name}": widget HTML com ${fmt(e.data.html.length)} caracteres (limite ${fmt(lim.maxHtmlChars)}).`);
          htmlChars += e.data.html.length;
          if (htmlChars > lim.maxTotalHtmlChars) throw new ImportBudgetError('HTML personalizado demais no arquivo.');
        }
        walk(e.data, `Quadro "${name}" (dados de widget)`, lim, acc, lim.maxWidgetNodes);
      }
      if (acc.chars > lim.maxTotalStringChars) throw new ImportBudgetError('Texto demais no arquivo.');
    }
  }
  let assets = 0, assetChars = 0;
  if (Array.isArray(data.assets)) {
    if (data.assets.length > lim.maxAssets) throw new ImportBudgetError(`Arquivo com ${fmt(data.assets.length)} arquivos/imagens (limite ${fmt(lim.maxAssets)}).`);
    for (const a of data.assets) {
      if (!isObj(a)) continue;
      assets++;
      const d = a.dataURL;
      if (typeof d === 'string') {
        if (d.length > lim.maxAssetDataURLChars) throw new ImportBudgetError(`Arquivo anexado "${String(a.name ?? a.id).slice(0, 60)}" maior que o limite de 25 MB.`);
        assetChars += d.length;
        if (assetChars > lim.maxTotalAssetChars) throw new ImportBudgetError('Arquivos anexados somam mais que o limite do backup.');
      }
      for (const f of ['id', 'name', 'mimeType'] as const) {
        const s = a[f];
        if (typeof s === 'string' && s.length > 1_000) throw new ImportBudgetError(`Arquivo anexado com campo ${f} inválido.`);
      }
    }
  }
  return { boards: boards.length, elements, points, htmlWidgets, assets, assetChars };
}

/** Orçamento genérico (formato legado v0.2/v0.3): profundidade e quantidade total de nós. */
export function checkGenericBudget(data: unknown, lim: ImportLimits = IMPORT_LIMITS, maxNodes = 8_000_000) {
  // No legado, imagens vêm embutidas como data URL em campos de texto: o teto por string é o de um asset.
  walk(data, 'Arquivo', { ...lim, maxStringChars: lim.maxAssetDataURLChars }, { chars: 0 }, maxNodes);
}
