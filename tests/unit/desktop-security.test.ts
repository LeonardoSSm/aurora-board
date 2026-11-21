/**
 * D1 — políticas puras do processo principal do Aurora Board Desktop (desktop/security.ts).
 */
import { describe, expect, it } from 'vitest';
import { join, resolve, sep } from 'node:path';
import { externalOpenTarget, isAppUrl, isPermissionAllowed, mimeOf, resolveAppFile } from '../../desktop/security';

const ROOT = resolve('/aurora/app/renderer');

describe('origem do app', () => {
  it('aceita só aurora://app (documento principal e hospedeiro do sandbox)', () => {
    expect(isAppUrl('aurora://app/index.html')).toBe(true);
    expect(isAppUrl('aurora://app/sandbox.html')).toBe(true);
    for (const u of ['aurora://outro/index.html', 'aurora://user:x@app/index.html', 'https://app/index.html', 'file:///C:/app/index.html', 'about:blank', 'data:text/html,x', 'javascript:alert(1)', 'blob:aurora://app/uuid', '', 'lixo']) expect(isAppUrl(u), u).toBe(false);
  });

  it('links externos: só http/https sem credenciais vão ao navegador do sistema', () => {
    expect(externalOpenTarget('https://github.com/LeonardoSSm')).toBe('https://github.com/LeonardoSSm');
    expect(externalOpenTarget('http://exemplo.com.br/')).toBe('http://exemplo.com.br/');
    for (const u of ['file:///etc/passwd', 'javascript:alert(1)', 'aurora://app/index.html', 'smb://servidor/x', 'ms-settings:privacy', 'vscode://file/x', 'https://u:p@exemplo.com/', 'data:text/html,x']) expect(externalOpenTarget(u), u).toBeNull();
  });

  it('permissões: só escrita sanitizada na área de transferência e tela cheia, e só para o app', () => {
    expect(isPermissionAllowed('clipboard-sanitized-write', 'aurora://app/index.html')).toBe(true);
    expect(isPermissionAllowed('fullscreen', 'aurora://app/index.html')).toBe(true);
    for (const p of ['media', 'geolocation', 'notifications', 'midi', 'hid', 'serial', 'usb', 'clipboard-read', 'openExternal', 'pointerLock', 'display-capture']) expect(isPermissionAllowed(p, 'aurora://app/index.html'), p).toBe(false);
    expect(isPermissionAllowed('fullscreen', 'https://evil.example.com/')).toBe(false);
  });
});

describe('arquivos servidos pelo protocolo aurora://app', () => {
  it('raiz vira index.html; caminhos válidos ficam dentro da pasta do frontend', () => {
    expect(resolveAppFile('aurora://app/', ROOT)).toEqual({ file: join(ROOT, 'index.html'), publicPath: '/index.html' });
    expect(resolveAppFile('aurora://app/sandbox.html', ROOT)?.publicPath).toBe('/sandbox.html');
    expect(resolveAppFile('aurora://app/assets/index-abc.js?v=1#x', ROOT)?.file).toBe(join(ROOT, 'assets', 'index-abc.js'));
  });

  it('nunca sai da pasta do frontend (travessia literal ou codificada)', () => {
    for (const u of ['aurora://app/../main.cjs', 'aurora://app/%2e%2e/main.cjs', 'aurora://app/%2E%2E%2Fmain.cjs', 'aurora://app/assets/..%2f..%2fmain.cjs', 'aurora://app/assets/%2e%2e/%2e%2e/%2e%2e/etc/passwd']) {
      const r = resolveAppFile(u, ROOT);
      expect(r === null || r.file.startsWith(ROOT + sep), u).toBe(true);
    }
    // O `..` que sobrevive à análise da URL (codificado como %2f) é recusado.
    expect(resolveAppFile('aurora://app/assets/..%2f..%2fmain.cjs', ROOT)).toBeNull();
  });

  it('recusa barras invertidas, bytes nulos, codificação inválida, outro host e outro esquema', () => {
    for (const u of ['aurora://app/..%5c..%5cmain.cjs', 'aurora://app/a%5cb', 'aurora://app/a%00.html', 'aurora://outro/index.html', 'file:///C:/x', 'https://app/index.html', 'aurora://app/%E0%A4%A']) expect(resolveAppFile(u, ROOT), u).toBeNull();
  });

  it('tipos MIME conhecidos; desconhecido vira octet-stream (nosniff impede execução)', () => {
    expect(mimeOf('a.js')).toMatch(/javascript/);
    expect(mimeOf('a.html')).toMatch(/text\/html/);
    expect(mimeOf('a.woff2')).toBe('font/woff2');
    expect(mimeOf('a.exe')).toBe('application/octet-stream');
  });
});
