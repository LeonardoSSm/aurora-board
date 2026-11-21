/**
 * CI-1 (#25) — contrato do workflow de CI para os testes de navegador.
 *
 * A CI roda os E2E e o build público + CSP dentro da imagem oficial do Playwright, sem `playwright install
 * --with-deps` (o apt travava o WebKit). Estes testes impedem as regressões que trariam o problema de volta
 * ou quebrariam a CI em silêncio: imagem sem digest, versão divergente do lockfile, instalação via apt por
 * execução, perda de navegadores/projetos ou das duas fases da CSP.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const workflow = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
  packages: Record<string, { version: string }>;
};
const dependabot = readFileSync(join(root, '.github/dependabot.yml'), 'utf8');

/** Linhas executáveis (sem comentários YAML). */
const code = workflow
  .split(/\r?\n/)
  .filter((l) => !l.trim().startsWith('#'))
  .join('\n');

/** Bloco de texto de um job (da linha `  <id>:` até o próximo job de mesmo recuo). */
function job(id: string): string {
  const start = code.indexOf(`\n  ${id}:\n`);
  expect(start, `job ${id} existe`).toBeGreaterThan(-1);
  const rest = code.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const IMAGE_RE = /image: mcr\.microsoft\.com\/playwright:v(\d+\.\d+\.\d+)-noble@sha256:([0-9a-f]{64})\s*\n/;
const BROWSER_JOBS = ['e2e', 'static'] as const;

describe('CI-1 — testes de navegador na imagem fixada do Playwright', () => {
  it.each(BROWSER_JOBS)('job %s roda na imagem oficial fixada por versão E digest, como usuário não root', (id) => {
    const block = job(id);
    expect(block).toMatch(/\n {4}container:\n/);
    expect(block).toMatch(IMAGE_RE);
    expect(block).toMatch(/options: --user 1001\b/);
  });

  it('a versão da imagem é exatamente a do @playwright/test e do playwright-core do lockfile', () => {
    const test = lock.packages['node_modules/@playwright/test']?.version;
    const core = lock.packages['node_modules/playwright-core']?.version;
    expect(test).toBeTruthy();
    expect(core).toBe(test);
    for (const id of BROWSER_JOBS) {
      expect(job(id).match(IMAGE_RE)?.[1], `imagem do job ${id}`).toBe(test);
    }
  });

  it('os dois jobs usam a MESMA imagem (tag e digest)', () => {
    const [a, b] = BROWSER_JOBS.map((id) => job(id).match(IMAGE_RE)?.[0]);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
  });

  it('nenhum passo instala navegadores ou dependências nativas por execução (apt / playwright install)', () => {
    expect(code).not.toMatch(/playwright install/);
    expect(code).not.toMatch(/--with-deps/);
    expect(code).not.toMatch(/apt(-get)? (install|update)/);
    expect(code).not.toMatch(/ms-playwright/); // cache antigo dos binários: inútil dentro da imagem
  });

  it('confere os navegadores da imagem antes dos testes, em cada projeto', () => {
    for (const id of BROWSER_JOBS) {
      const block = job(id);
      const check = block.indexOf('node scripts/ci/check-playwright-browsers.mjs ${{ matrix.project }}');
      const firstTest = block.indexOf('npx playwright test');
      expect(check, `passo de conferência no job ${id}`).toBeGreaterThan(-1);
      expect(check).toBeLessThan(firstTest);
    }
  });

  it('cobertura preservada: 4 projetos E2E e 3 navegadores do build público, com as duas fases da CSP', () => {
    expect(job('e2e')).toMatch(/project: \[chromium, firefox, webkit, mobile\]/);
    expect(job('e2e')).toMatch(/npx playwright test --project=\$\{\{ matrix\.project \}\}/);
    const st = job('static');
    expect(st).toMatch(/project: \[chromium, firefox, webkit\]/);
    expect(st).toMatch(/AURORA_CSP_MODE: report-only/);
    // fase 2 (CSP aplicada) — o segundo `playwright test` do job, sem AURORA_CSP_MODE
    expect(st.match(/npx playwright test -c playwright\.static\.config\.ts/g)?.length).toBe(2);
    expect(st).toMatch(/env: \{ CI: 'true' \}\s*$/);
  });

  it('nenhuma verificação existente foi desligada', () => {
    for (const id of ['typecheck', 'unit', 'build', 'audit', 'secrets']) job(id);
    expect(code).not.toMatch(/continue-on-error:\s*true/);
    expect(job('build')).toMatch(/Verificar o conteúdo do build público/);
    expect(job('build')).toMatch(/generate-hosting-config\.ts && git diff --exit-code/);
    expect(job('secrets')).toMatch(/gitleaks\/gitleaks-action@[0-9a-f]{40}/);
  });

  it('toda action continua fixada por SHA de commit (S1-SEC-017)', () => {
    const uses = [...code.matchAll(/uses: ([^\s]+)/g)].map((m) => m[1]);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u, u).toMatch(/@[0-9a-f]{40}$/);
  });

  it('o Dependabot traz o Playwright num PR próprio (a imagem precisa subir junto)', () => {
    const groupIdx = dependabot.search(/^ {6}playwright:/m);
    const genericIdx = dependabot.search(/^ {6}minor-e-patch:/m);
    expect(groupIdx).toBeGreaterThan(-1);
    // o grupo do Playwright vem antes do grupo genérico (o Dependabot usa o primeiro grupo que casar)
    expect(groupIdx).toBeLessThan(genericIdx);
    expect(dependabot).toMatch(/'@playwright\/test'/);
  });
});

describe('D1 — jobs do aplicativo desktop', () => {
  it('Linux roda na MESMA imagem fixada; o Electron só é baixado nos jobs do desktop', () => {
    const linux = job('desktop-linux');
    expect(linux.match(IMAGE_RE)?.[0]).toBe(job('e2e').match(IMAGE_RE)?.[0]);
    expect(linux).toMatch(/options: --user 1001\b/);
    expect(code).toMatch(/\n {2}ELECTRON_SKIP_BINARY_DOWNLOAD: '1'\n/);
    for (const id of ['desktop-linux', 'desktop-windows']) expect(job(id)).toMatch(/ELECTRON_SKIP_BINARY_DOWNLOAD: ''/);
  });

  it('Windows testa o app montado E o executável empacotado, no caminho que o electron-builder gera', () => {
    const win = job('desktop-windows');
    expect(win).toMatch(/runs-on: windows-latest/);
    expect(win).toMatch(/electron-builder --config electron-builder\.yml --win --publish never/);
    // Regressão (Codex, PR #37): separadores do caminho tinham sumido do YAML.
    expect(win).toContain("AURORA_DESKTOP_EXECUTABLE: '${{ github.workspace }}/release/win-unpacked/Aurora Board.exe'");
    expect(workflow).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
    expect(win.match(/npx playwright test -c playwright\.desktop\.config\.ts/g)).toHaveLength(3);
    // D1-D: instalação real em máquina descartável + instalador publicado como artefato NÃO assinado.
    expect(win).toMatch(/AURORA_INSTALL_TEST: '1'/);
    expect(win).toMatch(/win-x64-unsigned\.exe/);
  });

  it('Linux: AppImage e .deb gerados; o .deb é INSTALADO e testado sem root, com o sandbox configurado pelo pacote', () => {
    const lin = job('desktop-linux-package');
    expect(lin).toMatch(/runs-on: ubuntu-24\.04/);
    expect(lin).toMatch(/electron-builder --config electron-builder\.yml --linux --publish never/);
    expect(lin).toMatch(/sudo dpkg -i release\/Aurora-Board-\*-linux-amd64-unsigned\.deb/);
    expect(lin).toMatch(/test -u '\/opt\/Aurora Board\/chrome-sandbox' \|\| test -f \/etc\/apparmor\.d\/aurora-board/);
    expect(lin).toMatch(/AURORA_DESKTOP_EXECUTABLE: '\/opt\/Aurora Board\/aurora-board'/);
    expect(lin).not.toMatch(/AURORA_DESKTOP_NO_SANDBOX/); // pacote instalado roda com o sandbox do sistema
    expect(lin).toMatch(/x86_64-unsigned\.AppImage/);
  });

  it('nenhum job do desktop esconde falhas', () => {
    for (const id of ['desktop-linux', 'desktop-windows', 'desktop-linux-package']) expect(job(id)).not.toMatch(/continue-on-error/);
  });
});
