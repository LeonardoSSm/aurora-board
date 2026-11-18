/**
 * Servidor local do Aurora Board (proxy seguro para integrações externas).
 *
 * - Guarda chaves de API apenas em variáveis de ambiente (.env), nunca no frontend.
 * - Escuta somente em 127.0.0.1.
 * - Endpoints:
 *     GET  /api/health
 *     GET  /api/ai/providers        → provedores e se estão configurados (sem expor chaves)
 *     POST /api/ai/chat             → { provider, model?, system, messages[] }
 *     POST /api/link-preview        → { url } → título/descrição/imagem (Open Graph)
 *
 * Para produção multiusuário, substituir por um backend (ex.: NestJS) com autenticação.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { PROVIDERS, type ChatRequest } from './providers';

const PORT = Number(process.env.AURORA_API_PORT ?? 8787);
const MAX_BODY = 2 * 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJSON(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw Object.assign(new Error('Corpo da requisição muito grande.'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw Object.assign(new Error('JSON inválido.'), { status: 400 });
  }
}

function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v === '::' || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function meta(html: string, names: string[]): string {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*content=["']([^"']*)["']|<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${n}["']`, 'i');
    const m = re.exec(html);
    if (m) return decodeEntities((m[1] ?? m[2] ?? '').trim());
  }
  return '';
}

async function linkPreview(rawUrl: string) {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw Object.assign(new Error('URL inválida.'), { status: 400 });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw Object.assign(new Error('Apenas http/https.'), { status: 400 });
  // Proteção contra SSRF: não busca endereços da rede local.
  const addrs = isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true }).catch(() => []);
  if (!addrs.length) throw Object.assign(new Error('Domínio não encontrado.'), { status: 400 });
  if (addrs.some((a) => isPrivateAddress(a.address))) throw Object.assign(new Error('Endereços de rede local não são permitidos.'), { status: 400 });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'AuroraBoard-LinkPreview/1.0', accept: 'text/html' } });
    if (!res.ok) throw Object.assign(new Error(`O site respondeu ${res.status}.`), { status: 502 });
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('html')) return { title: url.hostname, description: type, image: '', siteName: url.hostname };
    const reader = res.body!.getReader();
    let html = '';
    const dec = new TextDecoder();
    while (html.length < 300_000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    void reader.cancel().catch(() => undefined);
    const title = meta(html, ['og:title', 'twitter:title']) || decodeEntities(/<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? url.hostname);
    let image = meta(html, ['og:image', 'twitter:image']);
    if (image) { try { image = new URL(image, url).href; } catch { image = ''; } }
    return { title: title.slice(0, 300), description: meta(html, ['og:description', 'description', 'twitter:description']).slice(0, 600), image, siteName: meta(html, ['og:site_name']) || url.hostname };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw Object.assign(new Error('Tempo esgotado ao buscar o link.'), { status: 504 });
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function validateChat(body: unknown): ChatRequest {
  const b = body as Partial<ChatRequest>;
  if (!b || typeof b !== 'object') throw Object.assign(new Error('Requisição inválida.'), { status: 400 });
  if (!b.provider || !(b.provider in PROVIDERS)) throw Object.assign(new Error('Provedor desconhecido.'), { status: 400 });
  if (typeof b.system !== 'string' || b.system.length > 200_000) throw Object.assign(new Error('Campo "system" inválido.'), { status: 400 });
  if (!Array.isArray(b.messages) || !b.messages.length || b.messages.length > 60) throw Object.assign(new Error('Mensagens inválidas.'), { status: 400 });
  for (const m of b.messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || m.content.length > 100_000)
      throw Object.assign(new Error('Mensagem inválida.'), { status: 400 });
  }
  if (b.model !== undefined && (typeof b.model !== 'string' || !/^[\w.:\-/]{1,100}$/.test(b.model))) throw Object.assign(new Error('Modelo inválido.'), { status: 400 });
  return b as ChatRequest;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return send(res, 200, { ok: true });
    if (req.method === 'GET' && url.pathname === '/api/ai/providers') {
      return send(res, 200, {
        providers: Object.values(PROVIDERS).map((p) => ({ id: p.id, name: p.name, configured: p.configured(), defaultModel: p.defaultModel() })),
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/ai/chat') {
      const body = validateChat(await readJSON(req));
      const provider = PROVIDERS[body.provider];
      if (!provider.configured()) return send(res, 400, { error: `${provider.name} não configurado: defina ${provider.envKey} no .env do servidor.` });
      const out = await provider.chat(body);
      return send(res, 200, out);
    }
    if (req.method === 'POST' && url.pathname === '/api/link-preview') {
      const body = (await readJSON(req)) as { url?: string };
      return send(res, 200, await linkPreview(String(body.url ?? '')));
    }
    send(res, 404, { error: 'Rota não encontrada.' });
  } catch (e) {
    const err = e as Error & { status?: number };
    if (!err.status || err.status >= 500) console.error('[api]', err.message);
    send(res, err.status ?? 500, { error: err.message || 'Erro interno.' });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const configured = Object.values(PROVIDERS).filter((p) => p.configured()).map((p) => p.name);
  console.log(`[aurora-api] http://127.0.0.1:${PORT} — IA configurada: ${configured.length ? configured.join(', ') : 'nenhuma (veja .env.example)'}`);
});
