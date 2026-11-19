import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { isLoopbackAddress } from './server/netSafety';

const API_PORT = Number(process.env.AURORA_API_PORT ?? 8787);

/**
 * S1-SEC-013: o proxy /api do Vite só atende o próprio computador. Se o dev server for exposto na rede
 * (`vite --host`), um vizinho conseguiria usar a API (e as chaves de IA) forjando `Host: localhost` —
 * o endereço do socket não pode ser forjado, então é ele que decide.
 */
function localOnlyApi(): Plugin {
  const guard = (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    if (req.url?.startsWith('/api') && !isLoopbackAddress(req.socket.remoteAddress)) {
      res.statusCode = 403;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ error: 'A API do Aurora Board só aceita conexões deste computador.' }));
      return;
    }
    next();
  };
  return {
    name: 'aurora-local-only-api',
    configureServer: (server) => { server.middlewares.use(guard); },
    configurePreviewServer: (server) => { server.middlewares.use(guard); },
  };
}

export default defineConfig({
  plugins: [localOnlyApi(), react(), tailwindcss()],
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
