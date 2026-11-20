/**
 * Servidor de desenvolvimento acessível na REDE LOCAL (porta 5174), com pareamento de computadores ligado.
 * A API (IA, prévia de links) continua no `npm run dev` deste computador (127.0.0.1:8787) e só atende
 * outros computadores PAREADOS (ver docs/SECURITY.md › Computadores pareados).
 * Use só em rede de confiança; encerre quando não precisar.
 */
process.env.AURORA_LAN_PAIRING = '1';
const { createServer } = await import('vite');
const server = await createServer({ server: { host: '0.0.0.0', port: 5174, strictPort: true } });
await server.listen();
server.printUrls();
console.log('[aurora-lan] Pareamento de computadores LIGADO. Requer o "npm run dev" rodando neste computador (API em 127.0.0.1:8787).');
