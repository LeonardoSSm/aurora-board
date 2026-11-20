/**
 * Issue #24 — Data Hub, D2-A: `aurora.dataset` (importação CSV/JSON, persistência, exportação, projeção,
 * privacidade e backup). Todos os dados são SINTÉTICOS.
 */
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { registerBuiltinWidgets } from '../../src/widgets/builtin';
import { cloneElements, createBoard, createLinear, createWidget } from '../../src/core/elements';
import { WIDGET } from '../../src/core/widgetIds';
import type { AuroraElement, Board, LinearElement, WidgetElement } from '../../src/core/schema';
import { getState, initialEditorState, setState } from '../../src/store/editor';
import { setAdapter } from '../../src/persistence/autosave';
import { MemoryAdapter } from '../../src/persistence/adapter';
import { applyImport, assetIdsOf, buildExport, parseImport } from '../../src/persistence/exportImport';
import { getDataflow } from '../../src/widgets/dataflow';
import { buildContextText, contextSources, financialTaint } from '../../src/integrations/aiContext';
import { getWidget, summarizeElement } from '../../src/widgets/registry';
import { BRIDGE_LIMITS, buildInputSnapshot, plainJSON } from '../../src/core/htmlBridge';
import { DATASET_LIMITS, DATASET_MIME, DatasetError, validateContent, type DatasetContent } from '../../src/data/model';
import { decodeDatasetBytes, parseDatasetText } from '../../src/data/parse';
import { datasetToCSV, datasetToJSON, isFormulaLike } from '../../src/data/export';
import { decodeDatasetAsset, encodeDatasetAsset } from '../../src/data/codec';
import { datasetEntry, deleteDatasetAsset, invalidateDatasets, loadDatasetContent, requestDataset, resetDatasetCacheForTests, saveDataset, setDatasetCacheLimitForTests } from '../../src/data/store';
import { PROJECTION_LIMITS, projectDataset } from '../../src/data/project';
import { sanitizeDatasetData, type DatasetData } from '../../src/widgets/builtin/dataset';

beforeAll(() => registerBuiltinWidgets());

let adapter: MemoryAdapter;
beforeEach(() => {
  resetDatasetCacheForTests();
  adapter = new MemoryAdapter();
  setAdapter(adapter);
  setState({ ...initialEditorState, boardId: 'b1', status: 'ready', elements: [], htmlAiGrants: [] });
});

const csv = (text: string, name = 'dados.csv') => parseDatasetText(name, text);
const json = (v: unknown, name = 'dados.json') => parseDatasetText(name, typeof v === 'string' ? v : JSON.stringify(v));
const small = (o: Partial<Record<keyof typeof DATASET_LIMITS, number>>) => ({ ...DATASET_LIMITS, ...o });

function datasetEl(source: DatasetData['source'], view: Partial<DatasetData['view']> = {}, title = 'Vendas'): WidgetElement {
  return createWidget(WIDGET.dataset, '1.0.0', title, 0, 0, 440, 300, { source, view: { page: 0, pageSize: 100, columns: [], ...view } }) as WidgetElement;
}
function link(a: AuroraElement, b: AuroraElement, kind: 'data' | 'context' = 'data', ports: { from?: string; to?: string } = {}): LinearElement {
  const l = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], {}, kind);
  l.startBinding = { elementId: a.id, fixedPoint: null };
  l.endBinding = { elementId: b.id, fixedPoint: null };
  l.connection = { ...l.connection, sourcePort: ports.from, targetPort: ports.to };
  return l;
}
async function stored(content: DatasetContent, name = 'vendas') {
  const assetId = await saveDataset(content, `${name}.csv`);
  return { assetId, name, kind: 'csv' as const, rows: content.rows.length, columns: content.columns.length, bytes: 100, importedAt: 1 };
}

const SALES = 'produto,região,valor,ativo,data\r\nCafé ☕,Sul,10.5,true,2026-01-05\r\n"Pão, francês",Norte,3,false,2026-01-06\r\n"Bolo ""da vó""\nlinha 2",Sul,,true,2026-01-07\r\n';

describe('CSV', () => {
  it('cabeçalho, BOM, aspas, aspas duplicadas, quebra de linha no campo, CRLF e Unicode', () => {
    const p = csv('﻿' + SALES);
    expect(p.kind).toBe('csv');
    expect(p.delimiter).toBe(',');
    expect(p.content.columns.map((c) => [c.label, c.type])).toEqual([['produto', 'text'], ['região', 'text'], ['valor', 'number'], ['ativo', 'boolean'], ['data', 'date']]);
    expect(p.content.rows).toEqual([
      ['Café ☕', 'Sul', 10.5, true, '2026-01-05'],
      ['Pão, francês', 'Norte', 3, false, '2026-01-06'],
      ['Bolo "da vó"\nlinha 2', 'Sul', null, true, '2026-01-07'],
    ]);
  });

  it('detecta ponto e vírgula e tabulação; decimal brasileiro só com vírgula decimal', () => {
    const br = csv('nome;valor\nA;1.234,50\nB;2,5\n');
    expect(br.delimiter).toBe(';');
    expect(br.content.rows).toEqual([['A', 1234.5], ['B', 2.5]]);
    const dots = csv('nome;valor\nA;1.234\nB;2.5\n');
    expect(dots.content.rows).toEqual([['A', 1.234], ['B', 2.5]]);
    const tab = csv('a\tb\n1\t2\n', 'x.tsv');
    expect(tab.delimiter).toBe('\t');
    expect(tab.content.rows).toEqual([[1, 2]]);
  });

  it('zeros à esquerda e inteiros longos continuam texto (CEP, códigos, documentos)', () => {
    const p = csv('cep,codigo,n\n01310-100,000123,7\n04538-133,12345678901234567890,8\n');
    expect(p.content.columns.map((c) => c.type)).toEqual(['text', 'text', 'number']);
    expect(p.content.rows[0]).toEqual(['01310-100', '000123', 7]);
    expect(p.content.rows[1][1]).toBe('12345678901234567890');
  });

  it('delimitador inconsistente é recusado com a linha do problema (sem estado parcial)', () => {
    expect(() => csv('a,b,c\n1,2,3\n4,5\n')).toThrow(/Linha 3: 2 campo\(s\), mas o cabeçalho tem 3/);
    expect(() => csv('a,b\n"aberto,2\n')).toThrow(/Aspas não fechadas/);
  });

  it('separadores vazios a mais no fim são tolerados com aviso', () => {
    const p = csv('a,b\n1,2,,\n3,4\n');
    expect(p.content.rows).toEqual([[1, 2], [3, 4]]);
    expect(p.warnings.join(' ')).toMatch(/ajustadas/);
  });

  it('cabeçalhos vazios, repetidos e perigosos ganham nomes técnicos seguros; o rótulo original é mantido', () => {
    const p = csv('__proto__,constructor,key,$x,nome,nome,,members\n1,2,3,4,5,6,7,8\n');
    const cols = p.content.columns;
    expect(cols.map((c) => c.key)).toEqual(['__proto___', 'constructor_', 'key_', 'x_', 'nome', 'nome_2', 'Coluna 7', 'members_']);
    expect(cols.map((c) => c.label)).toEqual(['__proto__', 'constructor', 'key', '$x', 'nome', 'nome', 'Coluna 7', 'members']);
    expect(p.warnings.join(' ')).toMatch(/Nome técnico ajustado/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('binário, UTF-8 inválido (nos BYTES), vazio e só cabeçalho', () => {
    expect(() => csv('PK\u0003\u0004\u0000\u0000xl/workbook.xml')).toThrow(/não parece texto/);
    // Latin-1 “João” (0xE3 sozinho) não é UTF-8: recusado na decodificação estrita dos bytes.
    expect(() => decodeDatasetBytes(new Uint8Array([0x6e, 0x0a, 0x4a, 0x6f, 0xe3, 0x6f, 0x0a]))).toThrow(/UTF-8/);
    expect(decodeDatasetBytes(new TextEncoder().encode('\ufeffn\nJoão\n'))).toBe('n\nJoão\n'); // BOM removido
    expect(() => csv('   \n')).toThrow(/vazio/);
    expect(csv('a,b\n').warnings.join(' ')).toMatch(/só tem o cabeçalho/);
  });

  it('limites: tamanho, linhas, colunas, células e texto por célula', () => {
    expect(() => parseDatasetText('a.csv', 'a,b\n' + '1,2\n'.repeat(20), small({ maxFileBytes: 40 }))).toThrow(/grande demais/);
    expect(() => parseDatasetText('a.csv', 'a,b\n' + '1,2\n'.repeat(11), small({ maxRows: 10 }))).toThrow(/Mais de 10 linhas/);
    expect(() => parseDatasetText('a.csv', Array.from({ length: 6 }, (_, i) => `c${i}`).join(',') + '\n1,2,3,4,5,6\n', small({ maxColumns: 5 }))).toThrow(/Mais de 5 colunas/);
    expect(() => parseDatasetText('a.csv', 'a,b,c\n' + '1,2,3\n'.repeat(4), small({ maxCells: 10 }))).toThrow(/Mais de 10 células/);
    expect(() => parseDatasetText('a.csv', `a\n${'x'.repeat(51)}\n`, small({ maxCellChars: 50 }))).toThrow(/50 caracteres/);
  });

  // Revisão do Codex (PR #27): com mais de 200 registros na amostra de 64 KB, o leitor estourava o limite de
  // linhas em TODOS os candidatos e a detecção caía na vírgula — o arquivo virava uma coluna só.
  it.each([[';', 'a;b'], ['\t', 'a\tb'], ['|', 'a|b']])('detecta %j mesmo com mais de 200 registros na amostra', (d, header) => {
    const body = Array.from({ length: 1500 }, (_, i) => `${i}${d}${i * 2}`).join('\n');
    const p = csv(`${header}\n${body}\n`, 'x.txt');
    expect(p.delimiter).toBe(d);
    expect(p.content.columns.map((c) => c.label)).toEqual(['a', 'b']);
    expect(p.content.rows[1499]).toEqual([1499, 2998]);
  });

  // Revisão do Codex (PR #27, 2ª rodada): só CR entre registros (sem LF) num arquivo > 64 KB caía na vírgula.
  it('detecta o delimitador em arquivo grande com quebras só CR', () => {
    const p = csv('a;b\r' + '1;2\r'.repeat(18_000));
    expect(p.delimiter).toBe(';');
    expect(p.content.columns.map((c) => c.type)).toEqual(['number', 'number']);
    expect(p.content.rows).toHaveLength(18_000);
  });

  it('detecta o delimitador quando a amostra corta um campo entre aspas com quebra de linha', () => {
    const head = 'a;b\n' + '1;2\n'.repeat(15_500); // ~62 KB
    const long = `"${'x\n'.repeat(4000)}"`; // 8 KB com quebras: o corte da amostra (64 KB) cai dentro das aspas
    const p = csv(`${head}3;${long}\n4;5\n`);
    expect(p.delimiter).toBe(';');
    expect(p.content.rows).toHaveLength(15_502);
  });

  it('texto que parece fórmula é IMPORTADO como texto (nada é avaliado)', () => {
    const p = csv('f\n=1+1\n"=HYPERLINK(""http://x"")"\n');
    expect(p.content.columns[0].type).toBe('text');
    expect(p.content.rows).toEqual([['=1+1'], ['=HYPERLINK("http://x")']]);
  });
});

describe('JSON', () => {
  it('lista de objetos: colunas na ordem em que aparecem, ausentes viram nulo, tipos inferidos', () => {
    const p = json([{ nome: 'Ana', idade: 30 }, { nome: 'Bia', cidade: 'São Paulo', idade: 25.5 }, { nome: 'Caio', idade: '?' }]);
    expect(p.kind).toBe('json');
    expect(p.content.columns.map((c) => [c.label, c.type])).toEqual([['nome', 'text'], ['idade', 'mixed'], ['cidade', 'text']]);
    expect(p.content.rows).toEqual([['Ana', 30, null], ['Bia', 25.5, 'São Paulo'], ['Caio', '?', null]]);
  });

  it('{ columns, rows } com listas ou objetos — e o JSON exportado pelo próprio app', () => {
    expect(json({ columns: ['a', { label: 'b' }], rows: [[1, 'x'], [2, null]] }).content.rows).toEqual([[1, 'x'], [2, null]]);
    expect(json({ columns: ['a', 'b'], rows: [{ a: 1, b: 2 }, { b: 3 }] }).content.rows).toEqual([[1, 2], [null, 3]]);
    expect(() => json({ columns: ['a', 'b'], rows: [[1]] })).toThrow(/Linha 1: 1 valor\(es\), mas há 2/);
  });

  it('objetos/listas dentro de células viram texto JSON com aviso; chaves perigosas não poluem protótipos', () => {
    const p = json('[{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "a": [1, 2]}]');
    expect(p.content.columns.map((c) => c.key)).toEqual(['__proto___', 'constructor_', 'a']);
    expect(p.content.rows[0]).toEqual(['{"polluted":true}', '{"prototype":{"polluted":true}}', '[1,2]']);
    expect(p.warnings.join(' ')).toMatch(/texto JSON/);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('formatos não reconhecidos, backups do app, profundidade e itens demais', () => {
    expect(() => json({ a: 1 })).toThrow(/não reconhecido/);
    expect(() => json([1, 2])).toThrow(/só objetos/);
    expect(() => json({ format: 'aurora-board', boards: [] })).toThrow(/backup do Aurora Board/);
    expect(() => json('{oops')).toThrow(/JSON válido/);
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(() => json([{ a: deep }])).toThrow(/aninhado demais/);
    expect(() => parseDatasetText('a.json', JSON.stringify([{ a: Array.from({ length: 50 }, (_, i) => i) }]), small({ maxJsonNodes: 20 }))).toThrow(/mais de 20 itens/);
  });
});

describe('validação do conteúdo guardado (não confiável)', () => {
  const ok = csv('a,b\n1,x\n').content;
  it('aceita o normal e recalcula as chaves a partir dos rótulos', () => {
    const forged = { ...ok, columns: [{ key: '__proto__', label: 'a', type: 'number' }, { key: 'evil', label: 'b', type: 'text' }] };
    expect(validateContent(forged).columns.map((c) => c.key)).toEqual(['a', 'b']);
  });
  it.each([
    ['formato', { ...ok, format: 'outro' }],
    ['versão', { ...ok, version: 2 }],
    ['linha curta', { ...ok, rows: [[1]] }],
    ['célula objeto', { ...ok, rows: [[{ x: 1 }, 'x']] }],
    ['NaN', { ...ok, rows: [[Number.NaN, 'x']] }],
    ['sem colunas', { ...ok, columns: [] }],
  ])('recusa %s', (_n, bad) => {
    expect(() => validateContent(bad)).toThrow(DatasetError);
  });
});

describe('codec do asset', () => {
  it('ida e volta com Unicode; tipo próprio', () => {
    const c = csv(SALES).content;
    const a = encodeDatasetAsset(c, 'vendas.csv');
    expect(a.mimeType).toBe(DATASET_MIME);
    expect(a.dataURL.startsWith(`data:${DATASET_MIME};base64,`)).toBe(true);
    expect(decodeDatasetAsset(a)).toEqual(c);
  });
  // Revisão do Codex (PR #27, 2ª rodada): a gravação limitava unidades UTF-16 e a leitura, bytes UTF-8 — um
  // conteúdo com muito Unicode gravava e depois não relia (o bloco sumia ao recarregar).
  it('o limite de gravação é em bytes UTF-8, o mesmo da leitura: o que grava sempre relê', () => {
    const c = validateContent({ format: 'aurora-dataset', version: 1, columns: [{ label: 't', type: 'text' }], rows: [['漢'.repeat(30)], ['\u0001'.repeat(10)]] });
    const json = JSON.stringify(c);
    const bytes = new TextEncoder().encode(json).length;
    expect(bytes).toBeGreaterThan(json.length);
    // Cabe em caracteres, não em bytes: tem de ser recusado ANTES de gravar.
    expect(() => encodeDatasetAsset(c, 'x', 'ds_x', json.length)).toThrow(/grande demais/);
    const ok = encodeDatasetAsset(c, 'x', 'ds_x', bytes);
    expect(decodeDatasetAsset(ok, bytes)).toEqual(c);
    expect(() => decodeDatasetAsset(ok, bytes - 1)).toThrow(/grande demais/);
  });

  it('recusa tipo errado, base64/JSON corrompido e conteúdo adulterado', () => {
    const a = encodeDatasetAsset(csv('a\n1\n').content, 'x');
    expect(() => decodeDatasetAsset({ ...a, mimeType: 'image/png' })).toThrow(DatasetError);
    expect(() => decodeDatasetAsset({ ...a, dataURL: a.dataURL.slice(0, -6) + '@@@@' })).toThrow(/corrompido/);
    const forged = `data:${DATASET_MIME};base64,${btoa(JSON.stringify({ format: 'aurora-dataset', version: 1, columns: [{ label: 'a', type: 'text' }], rows: [[{ x: 1 }]] }))}`;
    expect(() => decodeDatasetAsset({ mimeType: DATASET_MIME, dataURL: forged })).toThrow(/valor inválido/);
  });
});

describe('exportação CSV/JSON', () => {
  it('escapa aspas, separadores e quebras; começa com BOM; reimporta igual (Unicode incluído)', () => {
    const c = csv(SALES).content;
    const out = datasetToCSV(c);
    expect(out.startsWith('﻿')).toBe(true);
    expect(out).toContain('"Pão, francês"');
    expect(out).toContain('"Bolo ""da vó""\nlinha 2"');
    expect(csv(out).content).toEqual(c);
    expect(json(datasetToJSON(c, 'vendas')).content).toEqual(c);
  });

  it.each(['=1+1', '+A1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', ' =1', '\u0000=1', '​=1', '＝1+1', '＋1', '－1', '＠x', ' \t @cmd'])('neutraliza fórmula em texto: %j', (s) => {
    expect(isFormulaLike(s)).toBe(true);
    const out = datasetToCSV({ format: 'aurora-dataset', version: 1, columns: [{ key: 'f', label: 'f', type: 'text' }], rows: [[s]] });
    const cell = out.split('\r\n')[1];
    expect(cell.startsWith(`"'`)).toBe(true);
  });

  it('números de verdade não são alterados; texto comum também não; cabeçalho também é neutralizado', () => {
    const out = datasetToCSV({ format: 'aurora-dataset', version: 1, columns: [{ key: 'n', label: '=cab', type: 'number' }, { key: 't', label: 't', type: 'text' }], rows: [[-5, 'ok'], [null, 'a-b']] });
    expect(out).toBe('﻿"\'=cab",t\r\n-5,ok\r\n,a-b\r\n');
    for (const s of ['ok', 'a-b', 'e-mail', '5', '']) expect(isFormulaLike(s)).toBe(false);
  });

  // Revisão do Codex (PR #27, 3ª rodada): o JSON exportado de um dataset grande (mas aceito) passava do limite de
  // importação e não podia ser restaurado pelo próprio bloco. Vale para o CSV também.
  it('o que o app exporta (CSV e JSON) sempre cabe nos limites de reimportação — conjunto no teto de células', () => {
    const rows = Array.from({ length: DATASET_LIMITS.maxRows }, () => Array.from({ length: 20 }, () => '=bcde'));
    const c = validateContent({ format: 'aurora-dataset', version: 1, columns: Array.from({ length: 20 }, (_, i) => ({ label: `coluna_${i}`, type: 'text' })), rows });
    const enc = new TextEncoder();
    for (const [name, text] of [['x.json', datasetToJSON(c, 'x')], ['x.csv', datasetToCSV(c)]] as const) {
      expect(enc.encode(text).length, name).toBeLessThanOrEqual(DATASET_LIMITS.maxFileBytes);
      const back = parseDatasetText(name, text).content;
      expect(back.rows).toHaveLength(DATASET_LIMITS.maxRows);
      expect(back).toEqual(c); // ida e volta exata (o CSV neutraliza no arquivo e a importação desfaz)
    }
    expect(datasetToJSON(c, 'x')).not.toMatch(/\n/); // compacto
  });

  // Revisão do Codex (PR #27, 4ª rodada): três casos em que a ida e volta CSV mudava estrutura ou valores.
  // Revisão do Codex (PR #27, 5ª rodada): U+FFFD é um caractere legítimo; recusá-lo no texto decodificado
  // impedia reimportar o que o próprio app exportou.
  it('U+FFFD legítimo importa e volta pelo JSON e pelo CSV', () => {
    const c = json('[{"f":"a\\ufffdb"}]').content;
    expect(c.rows).toEqual([['a�b']]);
    const viaBytes = (name: string, text: string) => parseDatasetText(name, decodeDatasetBytes(new TextEncoder().encode(text))).content;
    expect(viaBytes('x.json', datasetToJSON(c, 'x'))).toEqual(c);
    expect(viaBytes('x.csv', datasetToCSV(c))).toEqual(c);
  });

  it('texto neutralizado continua texto na volta (não vira número)', () => {
    const c = json([{ f: '+123' }, { f: '-4' }]).content;
    const back = csv(datasetToCSV(c)).content;
    expect(back.rows).toEqual([['+123'], ['-4']]);
    expect(back.columns[0].type).toBe('text');
    expect(datasetToCSV(back)).toBe(datasetToCSV(c));
  });

  it('linhas nulas de um conjunto de UMA coluna são preservadas', () => {
    const c = json([{ f: null }, { f: 'x' }, { f: null }]).content;
    const back = csv(datasetToCSV(c)).content;
    expect(back.rows).toEqual([[null], ['x'], [null]]);
    // Linhas realmente em branco (sem aspas) num CSV de fora continuam ignoradas.
    expect(csv('f\nx\n\n\ny\n').content.rows).toEqual([['x'], ['y']]);
  });

  it.each([';', '\t', '|'])('valores e rótulos com outro delimitador (%j) não mudam a estrutura na volta', (d) => {
    const c = json([{ [`a${d}b`]: `1${d}2` }, { [`a${d}b`]: 'ok' }]).content;
    const back = csv(datasetToCSV(c)).content;
    expect(back.columns).toEqual(c.columns); // rótulos já normalizados na importação (TAB vira espaço)
    expect(back.rows).toEqual([[`1${d}2`], ['ok']]);
  });

  // Propriedade da ida e volta CSV (escopo documentado em docs/DATA_HUB.md): estrutura (linhas, colunas, nulos),
  // rótulos e TEXTOS voltam idênticos; tipos são reinferidos (para tipos exatos, JSON). Gerador com semente fixa.
  it('propriedade: 400 conjuntos aleatórios de texto com aspas, separadores, quebras, apóstrofos e fórmulas voltam idênticos pelo CSV', () => {
    let seed = 0x2468ace;
    const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const ALPHA = ['x', 'y', ' ', '"', ',', ';', '\t', '|', '\n', '\r\n', "'", '=', '+', '-', '@', 'ç', '漢', '☕', '0', '1', ' ', '＝'];
    const text = () => { let s = 'x'; for (let n = Math.floor(rnd() * 8); n > 0; n--) s = rnd() < 0.5 ? ALPHA[Math.floor(rnd() * ALPHA.length)] + s : s + ALPHA[Math.floor(rnd() * ALPHA.length)]; return s; };
    for (let it = 0; it < 400; it++) {
      const cols = 1 + Math.floor(rnd() * 3);
      const rows = Array.from({ length: Math.floor(rnd() * 5) }, () => Array.from({ length: cols }, () => (rnd() < 0.2 ? null : text())));
      const labels = Array.from({ length: cols }, (_, i) => `c${i}${rnd() < 0.3 ? ';=' : ''}`);
      const c = validateContent({ format: 'aurora-dataset', version: 1, columns: labels.map((label) => ({ label, type: 'text' })), rows });
      const back = csv(datasetToCSV(c)).content;
      expect(back.columns.map((x) => x.label), `iteração ${it}`).toEqual(c.columns.map((x) => x.label));
      // Textos aparados nas pontas por planilhas não acontecem aqui: a exportação põe entre aspas.
      expect(back.rows, `iteração ${it}`).toEqual(c.rows);
    }
  });

  it('célula no limite de tamanho que recebe o apóstrofo da exportação ainda reimporta', () => {
    const s = '=' + 'x'.repeat(DATASET_LIMITS.maxCellChars - 1);
    const c = validateContent({ format: 'aurora-dataset', version: 1, columns: [{ label: 'f', type: 'text' }], rows: [[s]] });
    const back = csv(datasetToCSV(c)).content;
    expect(back.rows[0][0]).toBe(s);
    expect(() => encodeDatasetAsset(back, 'x')).not.toThrow();
  });

  it('ida e volta CSV com textos que parecem fórmula: o ARQUIVO sempre neutralizado, o valor no app é o original (texto)', () => {
    const c = json([{ f: '=cmd|"/C calc"!A0' }, { f: '@SUM(1)' }, { f: "'=já tinha apóstrofo" }, { f: "''=dois" }, { f: "'texto comum" }, { f: " '=espaço antes" }]).content;
    const file = datasetToCSV(c);
    for (const line of file.split(/\r\n/).slice(1).filter(Boolean)) expect(isFormulaLike(line.replace(/^"/, ''))).toBe(false);
    const back = csv(file).content;
    expect(back).toEqual(c);
    expect(back.columns[0].type).toBe('text');
    // Reexportar neutraliza de novo (estável).
    expect(datasetToCSV(back)).toBe(file);
  });
});

describe('projeção para o fluxo de dados', () => {
  const big = (rows: number, cols = 3, cell = (r: number, c: number) => `v${r}-${c}` as string | number) =>
    validateContent({ format: 'aurora-dataset', version: 1, columns: Array.from({ length: cols }, (_, c) => ({ label: `c${c}`, type: 'text' })), rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => cell(r, c))) });

  it('paginação, colunas escolhidas e página fora do intervalo', () => {
    const c = big(250);
    const p = projectDataset(c, 'x', { page: 1, pageSize: 100, columns: ['c2', 'c0', 'inexistente'] });
    expect(p.summary).toMatchObject({ rowCount: 250, page: 1, pageCount: 3, offset: 100, rowsInPage: 100, projectedColumns: ['c0', 'c2'], truncated: false });
    expect(p.rows[0]).toEqual({ c0: 'v100-0', c2: 'v100-2' });
    expect(projectDataset(c, 'x', { page: 99, pageSize: 100 }).summary).toMatchObject({ page: 2, rowsInPage: 50 });
  });

  it('cada saída cabe no limite de valor do Bridge (64 KB) e o envio total no de entrada (1 MB); corte é informado', () => {
    const c = big(500, 20, (r, c) => `${'x'.repeat(150)}${r}${c}`);
    const p = projectDataset(c, 'x', { pageSize: 500 });
    expect(p.summary.truncated).toBe(true);
    expect(p.summary.notes.join(' ')).toMatch(/Página limitada/);
    for (const v of [p.rows, p.columns, p.summary]) {
      const j = plainJSON(v);
      expect(j.ok).toBe(true);
      expect(JSON.stringify(v).length).toBeLessThanOrEqual(BRIDGE_LIMITS.maxValueChars);
    }
    const snap = buildInputSnapshot([{ id: 'dados', label: 'd', type: 'object' }, { id: 'resumo', label: 'r', type: 'object' }, { id: 'cols', label: 'c', type: 'object' }], {
      dados: [{ value: p.rows, sourceTitle: 'x' }], resumo: [{ value: p.summary, sourceTitle: 'x' }], cols: [{ value: p.columns, sourceTitle: 'x' }],
    });
    expect(snap.errors).toEqual({});
    expect(snap.json.length).toBeLessThan(BRIDGE_LIMITS.maxInputChars);
  });

  // Revisão do Codex (PR #27, 6ª rodada): o Bridge remove propriedades `key`; o iframe recebia colunas sem o
  // identificador usado nas linhas.
  it('colunas chegam ao HTML com o identificador técnico (`id`) que indexa as linhas, inclusive reservadas/repetidas', () => {
    const p = projectDataset(csv('constructor,nome,nome,key\n1,a,b,c\n').content, 'x', {});
    const snap = buildInputSnapshot([{ id: 'cols', label: 'c', type: 'object' }, { id: 'linhas', label: 'l', type: 'object' }], {
      cols: [{ value: p.columns, sourceTitle: 'x' }], linhas: [{ value: p.rows, sourceTitle: 'x' }],
    });
    const cols = snap.inputs.cols as { id: string; label: string }[];
    const row = (snap.inputs.linhas as Record<string, unknown>[])[0];
    expect(cols.map((c) => [c.id, c.label])).toEqual([['constructor_', 'constructor'], ['nome', 'nome'], ['nome_2', 'nome'], ['key_', 'key']]);
    expect(cols.map((c) => row[c.id])).toEqual([1, 'a', 'b', 'c']);
  });

  it('células longas são encurtadas só na projeção; colunas acima do limite ficam fora das linhas', () => {
    const c = big(2, 60, (r, col) => (col === 0 ? 'y'.repeat(5000) : r));
    const p = projectDataset(c, 'x', {});
    expect((p.rows[0].c0 as string).length).toBe(PROJECTION_LIMITS.maxProjectedCellChars);
    expect(Object.keys(p.rows[0])).toHaveLength(PROJECTION_LIMITS.maxProjectedColumns);
    expect(p.columns).toHaveLength(60);
    expect(c.rows[0][0]).toHaveLength(5000);
  });

  it('estatísticas das colunas numéricas', () => {
    const p = projectDataset(csv('n,t\n1,a\n4,b\n,c\n').content, 'x', {});
    expect(p.summary.stats).toEqual({ n: { count: 2, sum: 5, min: 1, max: 4, mean: 2.5 } });
  });
});

describe('persistência local (asset imutável) e cache', () => {
  it('grava no armazenamento local, lê validado e exporta o mesmo conteúdo', async () => {
    const c = csv(SALES).content;
    const id = await saveDataset(c, 'vendas.csv');
    expect(adapter.assets.get(id)?.mimeType).toBe(DATASET_MIME);
    resetDatasetCacheForTests();
    expect(datasetEntry(id)).toBeUndefined();
    await requestDataset(id);
    expect(datasetEntry(id)).toMatchObject({ status: 'ready' });
    expect(await loadDatasetContent(id)).toEqual(c);
  });

  // Revisão do Codex (PR #27, P1): com o quadro usando mais células que o teto do cache, carregar um dataset
  // despejava outro EM USO; o recálculo pedia de novo o despejado — laço infinito de leituras e recálculos.
  it('datasets usados pelo quadro aberto não são despejados do cache (sem laço de recarga)', async () => {
    const ids = [];
    for (let i = 0; i < 3; i++) ids.push((await stored(csv(`v\n${i}\n${i}\n`).content, `d${i}`)).assetId); // 2 células cada
    setDatasetCacheLimitForTests(3);
    resetDatasetCacheForTests({ keepLimit: true });
    const els = ids.map((assetId, i) => datasetEl({ assetId, name: `d${i}`, kind: 'csv', rows: 2, columns: 1, bytes: 1, importedAt: 1 }));
    setState({ elements: els });
    let reads = 0;
    const get = adapter.getAsset.bind(adapter);
    adapter.getAsset = async (id: string) => { reads++; return get(id); };
    for (let round = 0; round < 5; round++) {
      getDataflow([...getState().elements]);
      await Promise.all(ids.map((id) => requestDataset(id)));
    }
    expect(reads).toBe(3);
    for (const id of ids) expect(datasetEntry(id)?.status).toBe('ready');
    // Um dataset FORA do quadro aberto pode sair do cache.
    const extra = (await stored(csv('v\n9\n9\n').content, 'fora')).assetId;
    resetDatasetCacheForTests({ keepLimit: true });
    for (const id of [extra, ...ids]) await requestDataset(id);
    expect(datasetEntry(extra)).toBeUndefined();
    setDatasetCacheLimitForTests(null);
  });

  // Revisão do Codex (PR #27, P2): “ausente” ficava no cache para sempre; restaurar o backup com os dados na
  // mesma sessão não fazia o bloco voltar.
  it('restaurar os dados invalida o “ausente” em cache (o bloco volta sem recarregar a página)', async () => {
    const c = csv('a\n1\n').content;
    const asset = encodeDatasetAsset(c, 'a', 'ds_volta');
    await requestDataset('ds_volta');
    expect(datasetEntry('ds_volta')).toEqual({ status: 'missing' });
    const src = { assetId: 'ds_volta', name: 'a', kind: 'csv' as const, rows: 1, columns: 1, bytes: 1, importedAt: 1 };
    const r = parseImport(buildExport([{ ...createBoard('ws1', 'B'), elements: [datasetEl(src)] }], [asset]), 'ws1');
    const res = await applyImport(adapter, r, { id: 'ws1', name: 'W', createdAt: 1, updatedAt: 1, boardOrder: [] }, () => 'b_x');
    expect(res.assetIds).toEqual(['ds_volta']);
    invalidateDatasets(res.assetIds);
    await requestDataset('ds_volta');
    expect(datasetEntry('ds_volta')).toMatchObject({ status: 'ready' });
  });

  it('asset ausente, corrompido e excluído', async () => {
    await requestDataset('ds_naoexiste');
    expect(datasetEntry('ds_naoexiste')).toEqual({ status: 'missing' });
    await adapter.putAsset({ id: 'ds_ruim', mimeType: DATASET_MIME, dataURL: `data:${DATASET_MIME};base64,!!!`, name: 'x', size: 1, createdAt: 1 });
    await requestDataset('ds_ruim');
    expect(datasetEntry('ds_ruim')).toMatchObject({ status: 'error' });
    const id = await saveDataset(csv('a\n1\n').content, 'a.csv');
    await deleteDatasetAsset(id);
    expect(adapter.assets.has(id)).toBe(false);
    expect(datasetEntry(id)).toEqual({ status: 'missing' });
    await expect(loadDatasetContent(id)).rejects.toThrow(/não estão disponíveis/);
  });
});

describe('bloco aurora.dataset', () => {
  const plugin = () => getWidget(WIDGET.dataset)!;

  it('sanitize: idempotente, sem dados no bloco, recusa referências e contagens forjadas', () => {
    const p = plugin();
    const raw = { source: { assetId: 'ds_ok', name: '<b>Nome‮</b>', kind: 'json', rows: 3, columns: 2, bytes: 10, importedAt: 5, rowsData: [[1]] }, view: { page: -3, pageSize: 99999, columns: ['a', 'a', 7] }, extra: 'x' };
    const d = p.sanitize(raw) as DatasetData;
    expect(d).toEqual({ source: { assetId: 'ds_ok', name: '<b>Nome</b>', kind: 'json', rows: 3, columns: 2, bytes: 10, importedAt: 5 }, view: { page: 0, pageSize: 500, columns: ['a'], groupBy: '', measure: '' }, ai: { mode: 'none', confirmedDigest: '', confirmedAt: 0 } });
    expect(p.sanitize(d)).toEqual(d);
    for (const bad of [{ assetId: '../x' }, { assetId: 'ok', rows: -1, columns: 1, bytes: 1 }, { assetId: 'ok', rows: 1, columns: 999, bytes: 1 }, { assetId: 'ok', rows: 1e9, columns: 1, bytes: 1 }]) {
      expect(sanitizeDatasetData({ source: bad }).source).toBeNull();
    }
  });

  it('saídas: vazio → carregando → pronto (rows/columns/summary/count) ou ausente', async () => {
    const src = await stored(csv(SALES).content);
    resetDatasetCacheForTests();
    const el = datasetEl(src, { pageSize: 2 });
    setState({ elements: [el] });
    let out = getDataflow(getState().elements).outputs.get(el.id)!;
    expect(out.$dataset).toEqual({ status: 'loading' });
    await requestDataset(src.assetId);
    out = getDataflow(getState().elements).outputs.get(el.id)!;
    expect(out.count).toEqual({ t: 'number', v: '3' });
    expect(out.rows).toEqual([
      { produto: 'Café ☕', 'região': 'Sul', valor: 10.5, ativo: true, data: '2026-01-05' },
      { produto: 'Pão, francês', 'região': 'Norte', valor: 3, ativo: false, data: '2026-01-06' },
    ]);
    expect((out.summary as { pageCount: number }).pageCount).toBe(2);
    expect((out.columns as unknown[]).length).toBe(5);
    const empty = datasetEl(null);
    expect(plugin().compute!(plugin().sanitize(empty.data), {}, empty)).toEqual({ $dataset: { status: 'empty' } });
  });

  it('Dados → Fórmula (count) e Dados → HTML (rows como objeto) pelo fluxo de dados', async () => {
    const src = await stored(csv('v\n1\n2\n3\n').content);
    const el = datasetEl(src);
    const f = createWidget(WIDGET.formula, '1.0.0', 'Total', 500, 0, 220, 120, { expression: 'x * 2' }) as WidgetElement;
    const h = createWidget(WIDGET.sandbox, '1.0.0', 'Painel', 500, 300, 360, 300, { html: '<p></p>', state: {}, bridge: { version: 1, inputs: [{ id: 'dados', label: 'Dados', type: 'object' }], outputs: [], ai: { mode: 'none', outputs: [], confirmedDigest: '', confirmedAt: 0 } } }) as WidgetElement;
    const e1 = link(el, f, 'data', { from: 'count', to: 'in' });
    const e2 = link(el, h, 'data', { from: 'rows', to: 'dados' });
    setState({ elements: [el, f, h, e1, e2] });
    const flow = getDataflow(getState().elements);
    expect(flow.edges.get(e1.id)?.status).toBe('ok');
    expect(flow.edges.get(e2.id)?.status).toBe('ok');
    expect(flow.inputs.get(f.id)?.in?.[0].value).toEqual({ t: 'number', v: '3' });
    expect(flow.inputs.get(h.id)?.dados?.[0].value).toEqual([{ v: 1 }, { v: 2 }, { v: 3 }]);
  });

  it('privacidade: resumo sem valores nem colunas; IA bloqueada direta e transitivamente (Dados → Fórmula → IA)', async () => {
    const src = await stored(csv('segredo_coluna\nVALOR-SECRETO\n').content);
    const el = datasetEl(src, {}, 'Planilha');
    const f = createWidget(WIDGET.formula, '1.0.0', 'Conta', 500, 0, 220, 120, { expression: 'x' }) as WidgetElement;
    const aiEl = createWidget(WIDGET.ai, '1.0.0', 'Assistente', 900, 0, 380, 460, { provider: 'anthropic' }) as WidgetElement;
    const edges = [link(el, f, 'data', { from: 'count', to: 'in' }), link(el, aiEl, 'context'), link(f, aiEl, 'context')];
    const elements = [el, f, aiEl, ...edges];
    setState({ elements });
    const text = summarizeElement(el);
    expect(text).not.toMatch(/VALOR-SECRETO|segredo_coluna/);
    expect(financialTaint(elements, f.id)).toMatch(/dados importados/);
    const sources = contextSources(elements, aiEl.id, {});
    expect(sources.every((s) => !s.includable)).toBe(true);
    expect(buildContextText(elements, sources.map((s) => ({ ...s, authorized: true, includable: true })))).toBe('');
  });

  it('duplicar compartilha o asset imutável; o asset entra nos ids de backup', async () => {
    const src = await stored(csv('a\n1\n').content);
    const el = datasetEl(src);
    const [copy] = cloneElements([el], { x: 10, y: 10 }) as WidgetElement[];
    expect(sanitizeDatasetData(copy.data).source?.assetId).toBe(src.assetId);
    expect(assetIdsOf([el, copy])).toEqual(new Set([src.assetId]));
  });
});

describe('backup e restauração com dados importados', () => {
  const board = (elements: AuroraElement[], id = 'b_dados'): Board => ({ ...createBoard('ws1', 'Dados'), id, elements });
  const ws = { id: 'ws1', name: 'W', createdAt: 1, updatedAt: 1, boardOrder: [] };

  it('restaura o dataset junto com o quadro, numa única gravação atômica', async () => {
    const c = csv(SALES).content;
    const src = await stored(c);
    const asset = adapter.assets.get(src.assetId)!;
    const text = buildExport([board([datasetEl(src)])], [asset]);
    const target = new MemoryAdapter();
    const r = parseImport(text, 'ws1');
    expect(r.warnings).toEqual([]);
    await applyImport(target, r, ws, () => 'b_novo');
    expect(decodeDatasetAsset(target.assets.get(src.assetId)!)).toEqual(c);
  });

  it('dataset adulterado no backup é descartado com aviso (o bloco fica sem dados, nada parcial)', async () => {
    const src = await stored(csv('a\n1\n').content);
    const forged = { id: src.assetId, mimeType: DATASET_MIME, dataURL: `data:${DATASET_MIME};base64,${btoa('{"format":"aurora-dataset","version":1,"columns":[{"label":"a"}],"rows":[[{"x":1}]]}')}`, name: 'x', size: 1, createdAt: 1 };
    const r = parseImport(buildExport([board([datasetEl(src)])], [forged]), 'ws1');
    expect(r.assets).toEqual([]);
    expect(r.warnings.join(' ')).toMatch(/Dados importados .* inválidos descartados/);
    expect(r.warnings.join(' ')).toMatch(/ausente no backup/);
  });

  it('backup sem os dados (decisão do usuário): restaura o bloco e avisa que o arquivo está ausente', async () => {
    const src = await stored(csv('a\n1\n').content);
    const r = parseImport(buildExport([board([datasetEl(src)])], []), 'ws1');
    expect(r.warnings.join(' ')).toMatch(new RegExp(`${src.assetId} ausente no backup`));
  });

  it('conflito de id com conteúdo DIFERENTE: o importado ganha id novo e o bloco importado aponta para ele', async () => {
    const mine = csv('a\nLOCAL\n').content;
    const theirs = csv('a\nDO-BACKUP\n').content;
    const local = encodeDatasetAsset(mine, 'local', 'ds_mesmo');
    const incoming = encodeDatasetAsset(theirs, 'backup', 'ds_mesmo');
    await adapter.putAsset(local);
    const src = { assetId: 'ds_mesmo', name: 'b', kind: 'csv' as const, rows: 1, columns: 1, bytes: 1, importedAt: 1 };
    const r = parseImport(buildExport([board([datasetEl(src)])], [incoming]), 'ws1');
    const { boardIds } = await applyImport(adapter, r, ws, () => 'b_novo');
    const saved = await adapter.loadBoard(boardIds[0]);
    const newId = sanitizeDatasetData((saved!.elements[0] as WidgetElement).data).source!.assetId;
    expect(newId).not.toBe('ds_mesmo');
    expect(decodeDatasetAsset(adapter.assets.get(newId)!)).toEqual(theirs);
    expect(decodeDatasetAsset(adapter.assets.get('ds_mesmo')!)).toEqual(mine);
    // Mesmo conteúdo: nada é duplicado.
    const again = parseImport(buildExport([board([datasetEl(src)])], [local]), 'ws1');
    const before = adapter.assets.size;
    await applyImport(adapter, again, ws, () => 'b_outro');
    expect(adapter.assets.size).toBe(before);
  });

  it('falha no meio da gravação não deixa dataset nem quadro parcial', async () => {
    const src = await stored(csv('a\n1\n').content);
    const asset = adapter.assets.get(src.assetId)!;
    const target = new MemoryAdapter();
    target.failCommitAfter = 1;
    const r = parseImport(buildExport([board([datasetEl(src)])], [asset]), 'ws1');
    await expect(applyImport(target, r, ws, () => 'b_novo')).rejects.toThrow(/Falha simulada/);
    expect(target.assets.size).toBe(0);
    expect(target.boards.size).toBe(0);
  });
});

