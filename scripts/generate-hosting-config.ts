/** Regenera os arquivos de hospedagem a partir de hosting/headers.ts: `npx tsx scripts/generate-hosting-config.ts`. */
import { writeFileSync } from 'node:fs';
import { renderHeadersFile, renderVercelJson } from '../hosting/headers';

writeFileSync('public/_headers', renderHeadersFile());
writeFileSync('vercel.json', renderVercelJson());
console.log('public/_headers e vercel.json atualizados.');
