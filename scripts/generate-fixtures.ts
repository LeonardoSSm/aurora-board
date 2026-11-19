/**
 * Gera fixtures CONGELADAS do formato atual (esquema 3) para testes de compatibilidade.
 * Rode apenas quando quiser registrar um novo formato: `npx tsx scripts/generate-fixtures.ts`.
 * As fixtures existentes NÃO devem ser regeneradas ao mudar o esquema — elas representam dados antigos reais.
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { buildDemoBoard } from '../src/store/demo';
import { buildExport } from '../src/persistence/exportImport';
import { createFreedraw, createImage, createLinear, createShape, createText, createWorkspace } from '../src/core/elements';
import { groupElements } from '../src/core/groups';
import type { Asset } from '../src/core/schema';

const ws = createWorkspace('Fixture');
const board = buildDemoBoard(ws.id);
board.name = 'Fixture esquema 3';
const asset: Asset = { id: 'a_fixture_png', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP8z8DwnwEIGBkZGRgYAAAhAQX/7xHnBQAAAABJRU5ErkJggg==', name: 'pixel.png', size: 70, createdAt: 1763500000000 };
const img = createImage(0, 700, 120, 120, asset.id);
const free = createFreedraw(200, 700, { strokeColor: '#69a8ff' });
free.points = [[0, 0, 0.5], [20, 10, 0.5], [40, 30, 0.6]];
const frame = createShape('frame', -60, 650, 600, 260);
frame.text = 'Área';
const txt = createText(300, 720, 'Texto livre\nduas linhas', { fontFamily: 'serif', fontSize: 28 });
const multi = createLinear('arrow', 380, 760, [[0, 0], [60, -40], [140, 20]]);
multi.path = 'curved';
const g1 = createShape('rectangle', 600, 700, 80, 60);
const g2 = createShape('ellipse', 700, 700, 80, 60);
const grouped = groupElements([g1, g2], new Set([g1.id, g2.id]), null).elements;
board.elements = [frame, ...board.elements, img, free, txt, multi, ...grouped];
for (const el of board.elements) el.frameId = el.id !== frame.id && el.y >= 650 && el.x >= -60 && el.x <= 540 ? frame.id : el.frameId;

mkdirSync('tests/fixtures', { recursive: true });
writeFileSync('tests/fixtures/aurora-export-v3.json', JSON.stringify(JSON.parse(buildExport([board], [asset], ws)), null, 1));
console.log(`fixture gerada: ${board.elements.length} elementos`);
