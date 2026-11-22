import { open } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { IMPORT_LIMITS } from '../src/persistence/importBudget';

export type ImportFileResult = { canceled: true } | { canceled: false; name: string; text: string } | { error: string };
export class ImportFileError extends Error {}

/** Só recebe o caminho escolhido no diálogo do SO, nunca um caminho fornecido pelo renderer. */
export async function readImportFile(path: string): Promise<{ name: string; text: string }> {
  if (extname(path).toLowerCase() !== '.json') throw new ImportFileError('Escolha um arquivo JSON.');
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new ImportFileError('Escolha um arquivo regular.');
    const limit = IMPORT_LIMITS.maxFileBytes;
    const tooLarge = () => new ImportFileError(`Arquivo grande demais (limite de ${limit / 1024 / 1024} MB).`);
    // Checagem antes de alocar/ler; o laço também limita arquivos que crescem durante a leitura.
    if (stat.size > limit) throw tooLarge();
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1));
      const { bytesRead } = await file.read(chunk);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > limit) throw tooLarge();
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return { name: basename(path), text: Buffer.concat(chunks, total).toString('utf8') };
  } finally { await file.close(); }
}
