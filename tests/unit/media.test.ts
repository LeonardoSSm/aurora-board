/** Ciclo S1 — classificação de mídias por conteúdo (S1-SEC-001/002, Etapa 8). */
import { describe, expect, it } from 'vitest';
import { checkImageBytes, classifyDocument, dataURLHead, downloadableBlob, imageDimensions, parseDataURL, safeDownloadName, sniffBytes } from '../../src/core/media';

const bytes = (s: string) => new TextEncoder().encode(s);
const hex = (...h: number[]) => new Uint8Array(h);
const PNG = hex(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const JPEG = hex(0xff, 0xd8, 0xff, 0xe0, 0, 16);
const HTML = '<!doctype html><html><body><script>parent.document.title="x"</script></body></html>';

describe('sniffBytes', () => {
  it.each([
    [PNG, 'png'],
    [JPEG, 'jpeg'],
    [bytes('GIF89a\x01\x00\x01\x00'), 'gif'],
    [bytes('RIFF\x00\x00\x00\x00WEBPVP8 '), 'webp'],
    [bytes('%PDF-1.7\n%âãÏÓ'), 'pdf'],
    [bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg'],
    [bytes('\uFEFF<?xml version="1.0"?>\n<!-- c --><!DOCTYPE svg><svg/>'), 'svg'],
    [bytes(HTML), 'text'],
    [bytes('linha 1\nlinha 2'), 'text'],
    [hex(0, 1, 2, 3, 4, 5), 'binary'],
    [new Uint8Array(), 'empty'],
  ])('%#: %s', (b, kind) => expect(sniffBytes(b as Uint8Array)).toBe(kind));
});

describe('parseDataURL', () => {
  it('base64 e percent-encoded', () => {
    expect([...parseDataURL('data:text/plain;base64,QUJD').bytes]).toEqual([65, 66, 67]);
    expect(new TextDecoder().decode(parseDataURL('data:text/plain,a%20b').bytes)).toBe('a b');
    expect(parseDataURL('data:Image/PNG;base64,AA==').mime).toBe('image/png');
  });
  it.each(['', 'http://x/a.png', 'data:text/plain;base64', 'data:;base64,@@@', 'data:text/plain,%E0%A4%A'])('recusa %s', (u) => expect(() => parseDataURL(u)).toThrow(/corrompido/));
});

describe('classifyDocument — o conteúdo decide, não o metadado', () => {
  it('HTML declarado como PDF vira TEXTO com aviso (nunca documento ativo)', () => {
    const v = classifyDocument(bytes(HTML), 'application/pdf', 'relatorio.pdf');
    expect(v).toMatchObject({ sniffed: 'text', preview: 'text', mismatch: true });
  });
  it('HTML declarado como imagem vira texto', () => expect(classifyDocument(bytes(HTML), 'image/png', 'a.png').preview).toBe('text'));
  it('HTML declarado como HTML é texto sem aviso', () => expect(classifyDocument(bytes(HTML), 'text/html', 'a.html')).toMatchObject({ preview: 'text', mismatch: false }));
  it('PDF real: sem prévia embutida', () => expect(classifyDocument(bytes('%PDF-1.4'), 'application/pdf', 'a.pdf')).toMatchObject({ preview: 'none', mismatch: false }));
  it('PDF real com MIME errado', () => expect(classifyDocument(bytes('%PDF-1.4'), 'text/html', 'a.html')).toMatchObject({ preview: 'none', mismatch: true }));
  it('PNG real com MIME errado → imagem com MIME derivado dos bytes', () => expect(classifyDocument(PNG, 'text/html', 'x.html')).toMatchObject({ preview: 'image', previewMime: 'image/png', mismatch: true }));
  it('SVG declarado → imagem (contexto <img>)', () => expect(classifyDocument(bytes('<svg onload="x()"/>'), 'image/svg+xml', 'a.svg')).toMatchObject({ preview: 'image', previewMime: 'image/svg+xml' }));
  it('SVG não declarado → texto', () => expect(classifyDocument(bytes('<svg/>'), 'application/pdf', 'a.pdf')).toMatchObject({ preview: 'text', mismatch: true }));
  it('binário desconhecido → só download', () => expect(classifyDocument(hex(0, 1, 2, 3), 'application/x-msdownload', 'a.exe').preview).toBe('none'));
  it('o MIME da prévia nunca é um tipo ativo', () => {
    for (const b of [PNG, JPEG, bytes(HTML), bytes('<svg/>'), bytes('%PDF-'), hex(0, 1)]) {
      for (const m of ['text/html', 'application/xhtml+xml', 'image/svg+xml', 'application/pdf', '']) {
        const v = classifyDocument(b, m, 'x');
        expect(['', 'text/plain', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']).toContain(v.previewMime);
        // SVG só como imagem, e só se o próprio conteúdo for SVG.
        if (v.previewMime === 'image/svg+xml') expect(v.sniffed).toBe('svg');
      }
    }
  });
});

describe('imagens: dimensões pelo cabeçalho e bombas de descompressão', () => {
  const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const png = (w: number, h: number) => hex(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(w), ...be32(h), 8, 6, 0, 0, 0);
  const gif = (w: number, h: number) => new Uint8Array([...bytes('GIF89a'), w & 255, w >> 8, h & 255, h >> 8, 0, 0, 0]);
  const jpeg = (w: number, h: number) => hex(0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0);
  it.each([
    ['png', png(640, 480), { width: 640, height: 480 }],
    ['gif', gif(300, 200), { width: 300, height: 200 }],
    ['jpeg', jpeg(1920, 1080), { width: 1920, height: 1080 }],
  ])('%s', (_k, b, d) => expect(imageDimensions(b as Uint8Array)).toEqual(d));
  it('aceita imagem normal e SVG', () => {
    expect(checkImageBytes(png(4000, 3000))).toMatchObject({ ok: true, width: 4000 });
    expect(checkImageBytes(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toMatchObject({ ok: true, kind: 'svg' });
  });
  it.each([
    ['PNG 50 000 × 50 000', png(50_000, 50_000)],
    ['PNG 12 000 × 12 000 (144 MP)', png(12_000, 12_000)],
    ['GIF 65 535 × 2', gif(65_535, 2)],
    ['JPEG 40 000 × 100', jpeg(40_000, 100)],
  ])('recusa %s', (_n, b) => expect(checkImageBytes(b as Uint8Array)).toMatchObject({ ok: false, reason: expect.stringMatching(/grande demais/) }));
  it('recusa HTML com extensão de imagem', () => expect(checkImageBytes(bytes(HTML))).toMatchObject({ ok: false, reason: expect.stringMatching(/não é uma imagem/) }));
  it('dataURLHead lê só o início e tolera lixo', () => {
    const big = 'data:image/png;base64,' + Buffer.from(png(10, 20)).toString('base64') + 'A'.repeat(1_000_000);
    expect(dataURLHead(big, 64).length).toBeLessThanOrEqual(66);
    expect(imageDimensions(dataURLHead(big))).toEqual({ width: 10, height: 20 });
    expect(dataURLHead('nada')).toHaveLength(0);
    expect(dataURLHead('data:image/png;base64,@@@')).toHaveLength(0);
  });
});

describe('download seguro', () => {
  it('blob de download é sempre octet-stream', () => expect(downloadableBlob(bytes(HTML)).type).toBe('application/octet-stream'));
  it.each([
    ['relatorio.pdf', 'relatorio.pdf'],
    ['../../etc/passwd', 'passwd'],
    ['C:\\Windows\\x.bat', 'x.bat'],
    ['a\u0000b<>:"|?*.txt', 'a_b_______.txt'],
    ['...', 'arquivo'],
    ['', 'arquivo'],
  ])('%s → %s', (i, o) => expect(safeDownloadName(i)).toBe(o));
});
