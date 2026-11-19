/** Ciclo S1 — configuração de hospedagem: arquivos gerados não divergem da fonte (hosting/headers.ts). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { csp, CSP_DIRECTIVES, headersForPath, renderHeadersFile, renderVercelJson, SANDBOX_CSP_BASE, SANDBOX_PATH, securityHeaders } from '../../hosting/headers';
import { SANDBOX_CSP } from '../../src/widgets/builtin/sandbox';

describe('arquivos de hospedagem', () => {
  it('public/_headers e vercel.json são exatamente o gerado (rode scripts/generate-hosting-config.ts)', () => {
    const lf = (s: string) => s.replace(/\r\n/g, '\n'); // checkout no Windows pode converter fins de linha
    expect(lf(readFileSync('public/_headers', 'utf8'))).toBe(renderHeadersFile());
    expect(lf(readFileSync('vercel.json', 'utf8'))).toBe(renderVercelJson());
  });
  it('vercel.json não publica automaticamente a partir do git', () => {
    expect(JSON.parse(renderVercelJson()).git.deploymentEnabled).toBe(false);
  });
  it('a regra do app na Vercel não se aplica ao hospedeiro do sandbox', () => {
    const src = JSON.parse(renderVercelJson()).headers[0].source as string;
    const re = new RegExp(`^${src}$`);
    expect(re.test('/index.html')).toBe(true);
    expect(re.test('/assets/index-abc.js')).toBe(true);
    expect(re.test('/sandbox.html')).toBe(false);
  });
});

describe('CSP do app', () => {
  const p = csp();
  it.each(["default-src 'self'", "script-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'", "connect-src 'self'", "frame-src 'self'", "worker-src 'none'"])('contém %s', (d) => expect(p).toContain(d));
  it('sem unsafe-inline/unsafe-eval/curingas em scripts', () => {
    expect(p).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|wasm-unsafe|\*/);
    const script = CSP_DIRECTIVES.find(([k]) => k === 'script-src')![1];
    expect(script).toBe("'self'");
  });
  it('meta não leva frame-ancestors (ignorado em <meta>)', () => expect(csp({ meta: true })).not.toContain('frame-ancestors'));
  it('cabeçalhos essenciais', () => {
    const h = securityHeaders();
    expect(h).toMatchObject({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'Cross-Origin-Opener-Policy': 'same-origin' });
    expect(h['Strict-Transport-Security']).toMatch(/max-age=31536000/);
    expect(securityHeaders('report-only')['Content-Security-Policy']).toBeUndefined();
  });
});

describe('hospedeiro do sandbox', () => {
  it('mesma política no componente, na <meta> do arquivo e no cabeçalho', () => {
    expect(SANDBOX_CSP).toBe(SANDBOX_CSP_BASE);
    const html = readFileSync('public/sandbox.html', 'utf8');
    expect(html).toContain(`content="${SANDBOX_CSP_BASE}"`);
    const h = headersForPath(SANDBOX_PATH);
    expect(h['Content-Security-Policy']).toBe(`${SANDBOX_CSP_BASE}; frame-ancestors 'self'`);
    expect(h['X-Frame-Options']).toBe('SAMEORIGIN');
  });
  it('a política do sandbox não tem rede nem origem', () => {
    expect(SANDBOX_CSP_BASE).toMatch(/default-src 'none'/);
    expect(SANDBOX_CSP_BASE).not.toMatch(/'self'|https?:|connect-src (?!'none')/);
  });
  it('o bootstrap se recusa a rodar sem origem opaca e só aceita mensagens do pai', () => {
    const html = readFileSync('public/sandbox.html', 'utf8');
    expect(html).toContain("self.origin !== 'null' || window.parent === window");
    expect(html).toContain('e.source !== window.parent');
    expect(html).not.toMatch(/<script[^>]+src=/);
  });
});
