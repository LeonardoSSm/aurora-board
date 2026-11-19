/**
 * Servidor local do Aurora Board (proxy seguro para integrações externas).
 * - Chaves de API somente em variáveis de ambiente (.env), nunca no frontend.
 * - Escuta apenas em 127.0.0.1. Lógica e proteções em ./app.ts e ./netSafety.ts (ver docs/SECURITY.md).
 * Para uso multiusuário, substituir por um backend com autenticação.
 */
import { createServer } from 'node:http';
import { createApp } from './app';
import { PROVIDERS } from './providers';

const PORT = Number(process.env.AURORA_API_PORT ?? 8787);

createServer(createApp()).listen(PORT, '127.0.0.1', () => {
  const configured = Object.values(PROVIDERS).filter((p) => p.configured()).map((p) => p.name);
  console.log(`[aurora-api] http://127.0.0.1:${PORT} — IA configurada: ${configured.length ? configured.join(', ') : 'nenhuma (veja .env.example)'}`);
});
