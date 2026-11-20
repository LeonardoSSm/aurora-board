/**
 * Servidor local do Aurora Board (proxy seguro para integrações externas).
 * - Chaves de API somente em variáveis de ambiente (.env), nunca no frontend.
 * - Escuta apenas em 127.0.0.1. Lógica e proteções em ./app.ts e ./netSafety.ts (ver docs/SECURITY.md).
 * Para uso multiusuário, substituir por um backend com autenticação.
 */
import { createServer } from 'node:http';
import { join } from 'node:path';
import { createApp } from './app';
import { PairingStore } from './pairing';
import { PROVIDERS } from './providers';
import { PluggyClient, readPluggyConfig } from './pluggy';

const PORT = Number(process.env.AURORA_API_PORT ?? 8787);

// O endereço de escuta é fixo de propósito (sem variável de ambiente para 0.0.0.0): esta API não tem
// autenticação e usa as SUAS chaves de IA. Ver docs/SECURITY.md › Servidor local.
const HOST = '127.0.0.1';

// Meu Pluggy (uso pessoal, somente leitura): credenciais só aqui, vindas do .env. Ver docs/finance/MEU_PLUGGY.md.
const pluggyCfg = readPluggyConfig();
const pluggy = { client: pluggyCfg.config ? new PluggyClient(pluggyCfg.config) : null, problems: pluggyCfg.problems, allowPaired: process.env.AURORA_PLUGGY_PAIRED_READ === '1' };

const server = createServer({ requestTimeout: 120_000, headersTimeout: 15_000 }, createApp({ pairing: new PairingStore({ file: join(process.cwd(), '.aurora-local', 'paired-devices.json') }), pluggy }));
server.maxConnections = 32;
server.listen(PORT, HOST, () => {
  const configured = Object.values(PROVIDERS).filter((p) => p.configured()).map((p) => p.name);
  console.log(`[aurora-api] http://${HOST}:${PORT} — IA configurada: ${configured.length ? configured.join(', ') : 'nenhuma (veja .env.example)'}`);
  console.log('[aurora-api] Uso local apenas: sem autenticação. Não exponha esta porta (túnel, proxy reverso, Docker -p).');
  console.log(`[aurora-api] Meu Pluggy: ${pluggy.client ? `configurado (${pluggy.client.itemIds.length} item(ns), somente leitura${pluggy.allowPaired ? ', leitura liberada a pareados' : ''})` : pluggyCfg.present ? `configuração incompleta — ${pluggyCfg.problems.join(' ')}` : 'não configurado'}`);
  console.log('[aurora-api] Outros computadores da sua rede só acessam via dispositivo pareado (AURORA_LAN_PAIRING=1 no Vite; ver docs/SECURITY.md).');
});
