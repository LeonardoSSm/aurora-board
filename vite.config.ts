import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { isLoopbackAddress } from './server/netSafety';
import { csp, headersForPath } from './hosting/headers';

const API_PORT = Number(process.env.AURORA_API_PORT ?? 8787);
const CSP_MODE = process.env.AURORA_CSP_MODE === 'report-only' ? 'report-only' : 'enforce';

/**
 * S1-SEC-013: o proxy /api do Vite só atende o próprio computador. Se o dev server for exposto na rede
 * (`vite --host`), um vizinho conseguiria usar a API (e as chaves de IA) forjando `Host: localhost` —
 * o endereço do socket não pode ser forjado, então é ele que decide.
 *
 * Exceção opcional — dispositivos pareados: com AURORA_LAN_PAIRING=1 neste processo do Vite, chamadas de
 * outro computador da rede são repassadas MARCADAS (`x-aurora-remote: 1`, cabeçalhos do cliente com esse
 * prefixo são descartados) e o servidor exige o token de um dispositivo pareado (server/pairing.ts).
 */
const LAN_PAIRING = process.env.AURORA_LAN_PAIRING === '1';
function localOnlyApi(): Plugin {
  const guard = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (!req.url?.startsWith('/api')) return next();
    // Nunca confiar em marcações vindas do cliente.
    for (const h of Object.keys(req.headers)) if (h.startsWith('x-aurora-remote')) delete req.headers[h];
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      if (LAN_PAIRING) {
        req.headers['x-aurora-remote'] = '1';
        req.headers['x-aurora-remote-addr'] = String(req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
        return next();
      }
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'A API do Aurora Board só aceita conexões deste computador.' }));
      return;
    }
    next();
  };
  // `vite preview` reproduz os cabeçalhos da hospedagem, por caminho (hosting/headers.ts).
  // AURORA_CSP_MODE=report-only serve a CSP do app só como relatório (fase 1 da validação).
  const hostingHeaders = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    for (const [k, v] of Object.entries(headersForPath(path, CSP_MODE))) res.setHeader(k, v);
    next();
  };
  return {
    name: 'aurora-local-only-api',
    configureServer: (server) => { server.middlewares.use(guard); },
    configurePreviewServer: (server) => { server.middlewares.use(guard); server.middlewares.use(hostingHeaders); },
  };
}

/** Build: injeta a CSP completa como <meta> (vale mesmo em hospedagem sem cabeçalhos configurados). */
function cspMeta(): Plugin {
  return {
    name: 'aurora-csp-meta',
    // Na fase Report-Only da validação a <meta> (que sempre bloqueia) não é injetada.
    apply: (_config, env) => env.command === 'build' && process.env.AURORA_CSP_MODE !== 'report-only',
    transformIndexHtml: (html) => html.replace('<meta charset="UTF-8" />', `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${csp({ meta: true })}" />`),
  };
}

export default defineConfig({
  plugins: [localOnlyApi(), cspMeta(), react(), tailwindcss()],
  build: { sourcemap: false },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false },
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    setupFiles: ['tests/unit/setup.ts'],
  },
} as never);
