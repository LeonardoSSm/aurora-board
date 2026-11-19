/**
 * Cabeçalhos de segurança do frontend estático (ciclo S1 — S1-SEC-012). FONTE ÚNICA DA VERDADE:
 * - `vite preview` aplica exatamente estes cabeçalhos (homologação local, testes `e2e/static`);
 * - `public/_headers` (Cloudflare Pages/Netlify) e `vercel.json` são verificados contra este arquivo
 *   por `tests/unit/hosting.test.ts` — não edite um sem o outro;
 * - o build injeta a mesma CSP como <meta> (proteção mesmo em hospedagem sem cabeçalhos próprios;
 *   `frame-ancestors` só funciona como cabeçalho).
 *
 * Política derivada do build real, validada primeiro em Report-Only (docs/security/S1-HOSTING.md):
 * - scripts e estilos só de arquivos do próprio site — nenhum 'unsafe-inline'/'unsafe-eval';
 *   (estilos de componentes React são aplicados via CSSOM, que a CSP não bloqueia);
 * - imagens: do site, data:/blob: (assets locais e exportação) e https: (somente após clique do usuário
 *   em imagens externas — S1-SEC-011);
 * - frame-src 'self': o único iframe é /sandbox.html (documento próprio dos widgets HTML, com CSP própria —
 *   um srcdoc herdaria esta política e os scripts dos widgets não rodariam); navegar para outra origem é bloqueado;
 * - font-src data:: fontes embutidas no SVG usado na exportação (fontes não executam código);
 * - sem rede além do próprio site (connect-src 'self'): a versão pública não tem /api.
 */

export const CSP_DIRECTIVES: [string, string][] = [
  ['default-src', "'self'"],
  ['script-src', "'self'"],
  ['style-src', "'self'"],
  ['img-src', "'self' data: blob: https:"],
  ['font-src', "'self' data:"], // data:: fontes embutidas no SVG da exportação PNG/SVG
  ['connect-src', "'self'"],
  ['media-src', "'self' data: blob:"],
  ['frame-src', "'self'"], // só /sandbox.html (widgets HTML); navegação para outras origens bloqueada
  ['child-src', "'self'"],
  ['worker-src', "'none'"],
  ['object-src', "'none'"],
  ['manifest-src', "'self'"],
  ['base-uri', "'none'"],
  ['form-action', "'none'"],
  ['frame-ancestors', "'none'"],
];

export const csp = (opts: { meta?: boolean } = {}) =>
  CSP_DIRECTIVES.filter(([k]) => !(opts.meta && k === 'frame-ancestors')) // não suportado em <meta>
    .map(([k, v]) => (v ? `${k} ${v}` : k))
    .join('; ');

export const PERMISSIONS_POLICY = [
  'camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'serial=()', 'bluetooth=()', 'hid=()',
  'midi=()', 'display-capture=()', 'accelerometer=()', 'gyroscope=()', 'magnetometer=()', 'browsing-topics=()',
].join(', ');

/**
 * CSP do documento hospedeiro dos widgets HTML (public/sandbox.html). Igual à <meta> do arquivo e a
 * SANDBOX_CSP do componente (verificado em tests/unit/hosting.test.ts), mais frame-ancestors 'self'.
 */
export const SANDBOX_CSP_BASE = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; base-uri 'none'; form-action 'none'; frame-src 'none'; object-src 'none'";
export const SANDBOX_DOCUMENT_CSP = `${SANDBOX_CSP_BASE}; frame-ancestors 'self'`;
export const SANDBOX_PATH = '/sandbox.html';

/** Cabeçalhos aplicados a todas as respostas do app. */
export function securityHeaders(mode: 'enforce' | 'report-only' = 'enforce'): Record<string, string> {
  return {
    [mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only']: csp(),
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS_POLICY,
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  };
}

/** Cabeçalhos de uma resposta pelo caminho (o hospedeiro do sandbox tem política própria). */
export function headersForPath(pathname: string, mode: 'enforce' | 'report-only' = 'enforce'): Record<string, string> {
  if (pathname !== SANDBOX_PATH) return securityHeaders(mode);
  const h = securityHeaders('enforce');
  delete h['Content-Security-Policy'];
  return { ...h, 'Content-Security-Policy': SANDBOX_DOCUMENT_CSP, 'X-Frame-Options': 'SAMEORIGIN' };
}

/** Cache: HTML sempre revalidado; assets com hash no nome são imutáveis. */
export const CACHE_RULES: { path: string; value: string }[] = [
  { path: '/index.html', value: 'no-cache' },
  { path: '/', value: 'no-cache' },
  { path: '/assets/*', value: 'public, max-age=31536000, immutable' },
];

/** Conteúdo de `public/_headers` (Cloudflare Pages / Netlify). Gerado — ver scripts/generate-hosting-config.ts. */
export function renderHeadersFile(): string {
  const lines = ['# Gerado por scripts/generate-hosting-config.ts a partir de hosting/headers.ts — não edite à mão.', '/*'];
  for (const [k, v] of Object.entries(securityHeaders())) lines.push(`  ${k}: ${v}`);
  // Regra mais específica: remove (!) os cabeçalhos do app e aplica os do hospedeiro do sandbox (Cloudflare Pages).
  lines.push(SANDBOX_PATH, '  ! Content-Security-Policy', '  ! X-Frame-Options', `  Content-Security-Policy: ${SANDBOX_DOCUMENT_CSP}`, '  X-Frame-Options: SAMEORIGIN');
  for (const r of CACHE_RULES) lines.push(r.path, `  Cache-Control: ${r.value}`);
  return lines.join('\n') + '\n';
}

/**
 * Conteúdo de `vercel.json`. `git.deploymentEnabled: false`: conectar o repositório à Vercel NÃO publica a
 * main automaticamente — a publicação é um passo manual e deliberado (ver docs/security/S1-HOSTING.md).
 */
export function renderVercelJson(): string {
  const toVercel = (h: Record<string, string>) => Object.entries(h).map(([key, value]) => ({ key, value }));
  const config = {
    $schema: 'https://openapi.vercel.sh/vercel.json',
    framework: null,
    buildCommand: 'npm run build',
    outputDirectory: 'dist',
    git: { deploymentEnabled: false },
    headers: [
      { source: '/((?!sandbox\\.html$).*)', headers: toVercel(securityHeaders()) },
      { source: SANDBOX_PATH, headers: toVercel(headersForPath(SANDBOX_PATH)) },
      { source: '/', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/index.html', headers: [{ key: 'Cache-Control', value: 'no-cache' }] },
      { source: '/assets/(.*)', headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }] },
    ],
  };
  return JSON.stringify(config, null, 2) + '\n';
}
