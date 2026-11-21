/**
 * Exemplos editáveis da ponte de dados (issue #11). Só usam a API documentada. Só o “Dashboard público (GitHub)”
 * (H2) consulta a rede — com aurora.request(), depois de autorização, e só quando o usuário clica em Atualizar.
 */
import type { BridgeConfig } from '../../core/htmlBridge';

export interface BridgeExample { id: string; name: string; html: string; bridge: BridgeConfig }

const ai = { mode: 'none' as const, outputs: [], confirmedDigest: '', confirmedAt: 0 };

const DASHBOARD = `<style>
  .k{display:grid;grid-template-columns:repeat(auto-fit,minmax(90px,1fr));gap:8px;padding:10px}
  .c{border:1px solid #2a3a52;border-radius:8px;padding:8px}
  .l{font-size:11px;color:#9cb1cf}.v{font-size:18px;font-weight:700}
  .pos{color:#5fd39a}.neg{color:#ff8a8a}
</style>
<div class="k">
  <div class="c"><div class="l">Receitas</div><div class="v" id="inc">—</div></div>
  <div class="c"><div class="l">Despesas</div><div class="v" id="exp">—</div></div>
  <div class="c"><div class="l">Saldo</div><div class="v" id="bal">—</div></div>
</div>
<script>
  // Dinheiro chega como { cents, currency }. Publique em centavos inteiros.
  const fmt = (c, cur) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: cur || 'BRL' });
  aurora.onInputs((inp) => {
    const inc = inp.receitas, exp = inp.despesas;
    const cur = (inc && inc.currency) || (exp && exp.currency) || 'BRL';
    const ic = inc ? inc.cents : 0, ec = exp ? Math.abs(exp.cents) : 0;
    const bal = ic - ec;
    document.getElementById('inc').textContent = inc ? fmt(ic, cur) : '—';
    document.getElementById('exp').textContent = exp ? fmt(ec, cur) : '—';
    const b = document.getElementById('bal');
    b.textContent = fmt(bal, cur);
    b.className = 'v ' + (bal >= 0 ? 'pos' : 'neg');
    aurora.publish('saldo', { cents: bal, currency: cur });
    aurora.publish('resumo', bal >= 0 ? 'Saldo positivo no período.' : 'Saldo negativo no período.');
  });
</script>`;

const TASKS = `<div style="padding:10px">
  <b>Tarefas recebidas</b>
  <p id="t">Conecte um bloco de Tarefas à entrada “tarefas”.</p>
</div>
<script>
  aurora.onInputs((inp) => {
    const list = Array.isArray(inp.tarefas) ? inp.tarefas : [];
    const done = list.filter((x) => x && (x.done === true || x.status === 'done')).length;
    const pending = list.length - done;
    document.getElementById('t').textContent = list.length + ' tarefa(s): ' + done + ' concluída(s), ' + pending + ' pendente(s).';
    aurora.publish('pendentes', pending);
    aurora.publish('resumo', pending ? pending + ' tarefa(s) pendente(s).' : 'Nenhuma tarefa pendente.');
  });
</script>`;

const CALC = `<div style="padding:10px">
  <label>Meta mensal (R$) <input id="m" type="number" step="0.01" style="width:100px"></label>
  <p id="o"></p>
</div>
<script>
  // O estado guarda só a PREFERÊNCIA (a meta), nunca as entradas.
  const m = document.getElementById('m');
  m.value = (aurora.state && aurora.state.meta) || 1000;
  function run() {
    const meta = Math.round(Number(m.value || 0) * 100);
    const gasto = aurora.inputs.gasto ? Math.abs(aurora.inputs.gasto.cents) : 0;
    const pct = meta ? gasto / meta : 0;
    document.getElementById('o').textContent = 'Usado: ' + (pct * 100).toFixed(1) + '% da meta';
    aurora.publish('uso', pct);
    aurora.publish('restante', { cents: meta - gasto, currency: 'BRL' });
  }
  m.onchange = () => { aurora.setState({ meta: Number(m.value || 0) }); run(); };
  aurora.onInputs(run);
</script>`;

/**
 * Issue #24 (D2-B) — dashboard sobre “Dados importados”. Recebe a página de linhas, as colunas, o resumo e o
 * agrupamento nativo (conjunto inteiro); mostra KPIs, filtro, tabela e gráfico de barras; publica métricas.
 * Só DOM por createElement/textContent (dados importados nunca viram HTML). O estado guarda só preferências.
 */
const DATASET_DASHBOARD = `<style>
  body{font:12px system-ui,sans-serif;color:#dbe6f5;margin:0}
  .w{padding:10px;display:flex;flex-direction:column;gap:8px}
  .k{display:grid;grid-template-columns:repeat(auto-fit,minmax(96px,1fr));gap:6px}
  .c{border:1px solid #2a3a52;border-radius:8px;padding:6px 8px}
  .l{font-size:10px;color:#9cb1cf}.v{font-size:16px;font-weight:700}
  .f{display:flex;gap:6px;flex-wrap:wrap;align-items:center}
  select{background:#0f1826;color:#dbe6f5;border:1px solid #2a3a52;border-radius:6px;padding:2px 4px;max-width:150px}
  table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #22324a;padding:2px 6px;text-align:left;white-space:nowrap;max-width:160px;overflow:hidden;text-overflow:ellipsis}
  th{color:#9cb1cf;font-weight:600}.n{text-align:right}.m{color:#9cb1cf}
</style>
<div class="w">
  <div id="vazio" class="m">Conecte um bloco “Dados importados” (linhas, colunas, resumo e agrupamento).</div>
  <div class="k">
    <div class="c"><div class="l">Linhas no conjunto</div><div class="v" id="kTotal">—</div></div>
    <div class="c"><div class="l">Linhas filtradas (página)</div><div class="v" id="kFiltradas">—</div></div>
    <div class="c"><div class="l" id="lSoma">Soma</div><div class="v" id="kSoma">—</div></div>
    <div class="c"><div class="l" id="lMedia">Média</div><div class="v" id="kMedia">—</div></div>
  </div>
  <div class="f">
    <label>Medida <select id="sMedida"></select></label>
    <label>Filtrar <select id="sColuna"></select></label>
    <select id="sValor"></select>
  </div>
  <svg id="grafico" width="100%" height="120" viewBox="0 0 320 120" preserveAspectRatio="none"></svg>
  <div class="m" id="legenda"></div>
  <table><thead><tr id="cab"></tr></thead><tbody id="corpo"></tbody></table>
</div>
<script>
  // Preferências (NUNCA linhas): medida e filtro escolhidos. valor: null = todos; '' = células vazias.
  const pref = Object.assign({ medida: '', coluna: '', valor: null }, aurora.state || {});
  if (typeof pref.valor !== 'string') pref.valor = null;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => (typeof n === 'number' && isFinite(n) ? n.toLocaleString('pt-BR', { maximumFractionDigits: 2 }) : '—');
  const txt = (v) => (v === null || v === undefined ? '' : String(v));
  function el(tag, text, cls) { const e = document.createElement(tag); if (text !== undefined) e.textContent = text; if (cls) e.className = cls; return e; }
  function options(sel, list, current, first) {
    sel.replaceChildren();
    if (first) sel.appendChild(el('option', first)).value = '';
    for (const o of list) { const op = el('option', o.label); op.value = o.value; sel.appendChild(op); }
    sel.value = list.some((o) => o.value === current) ? current : '';
  }
  // Opção de valor: 'v:' + valor (assim “(vazio)” = 'v:' nunca se confunde com “(todos)” = '').
  const optValor = (v) => 'v:' + v;
  let last = { linhas: [], colunas: [], resumo: null, grupos: null };
  function render() {
    const { linhas, resumo, grupos } = last;
    // Só as colunas que vêm nas linhas (resumo.projectedColumns): as demais existem no conjunto, mas não foram entregues.
    const proj = resumo && Array.isArray(resumo.projectedColumns) ? new Set(resumo.projectedColumns) : linhas.length ? new Set(Object.keys(linhas[0])) : null;
    const colunas = proj ? last.colunas.filter((c) => proj.has(c.id)) : last.colunas;
    $('vazio').style.display = last.colunas.length ? 'none' : '';
    const numericas = colunas.filter((c) => c.type === 'number');
    const textuais = colunas.filter((c) => c.type !== 'number');
    if (!numericas.some((c) => c.id === pref.medida)) pref.medida = numericas.length ? numericas[0].id : '';
    options($('sMedida'), numericas.map((c) => ({ value: c.id, label: c.label })), pref.medida, numericas.length ? '' : '(sem colunas numéricas)');
    // A coluna do filtro sumiu (dados trocados ou não projetada): o filtro deixa de valer — e a tela mostra isso.
    if (pref.coluna && !textuais.some((c) => c.id === pref.coluna)) { pref.coluna = ''; pref.valor = null; }
    options($('sColuna'), textuais.map((c) => ({ value: c.id, label: c.label })), pref.coluna, '(sem filtro)');
    const valores = pref.coluna ? [...new Set(linhas.map((r) => txt(r[pref.coluna])))].slice(0, 100) : [];
    const opcoes = valores.map((v) => ({ value: optValor(v), label: v || '(vazio)' }));
    // O valor escolhido continua visível mesmo sem linhas nesta página: o seletor mostra o filtro que está valendo.
    if (pref.coluna && pref.valor !== null && !valores.includes(pref.valor)) opcoes.unshift({ value: optValor(pref.valor), label: (pref.valor || '(vazio)') + ' (sem linhas aqui)' });
    options($('sValor'), opcoes, pref.valor === null ? '' : optValor(pref.valor), '(todos)');
    $('sValor').style.display = pref.coluna ? '' : 'none';
    const filtradas = linhas.filter((r) => !pref.coluna || pref.valor === null || txt(r[pref.coluna]) === pref.valor);
    const nums = filtradas.map((r) => r[pref.medida]).filter((v) => typeof v === 'number' && isFinite(v));
    const soma = nums.reduce((a, b) => a + b, 0);
    const media = nums.length ? soma / nums.length : null;
    const medidaLabel = (colunas.find((c) => c.id === pref.medida) || {}).label || 'medida';
    $('kTotal').textContent = resumo ? fmt(resumo.rowCount) : fmt(linhas.length);
    $('kFiltradas').textContent = fmt(filtradas.length);
    $('lSoma').textContent = 'Soma de ' + medidaLabel; $('kSoma').textContent = fmt(soma);
    $('lMedia').textContent = 'Média de ' + medidaLabel; $('kMedia').textContent = fmt(media);
    // Gráfico: agrupamento nativo (conjunto inteiro) quando conectado; senão, a página filtrada por grupo.
    let barras = [];
    if (grupos && Array.isArray(grupos.groups)) {
      barras = grupos.groups.slice(0, 8).map((g) => ({ label: g.group === null ? '(vazio)' : g.group, valor: grupos.measure ? g.sum : g.count }));
      $('legenda').textContent = (grupos.measure ? 'Soma de ' + grupos.measure.label : 'Contagem') + ' por ' + grupos.groupBy.label + ' (conjunto inteiro' + (grupos.truncated ? ', limitado' : '') + ')';
    } else if (pref.coluna) {
      const m = new Map();
      for (const r of filtradas) { const k = txt(r[pref.coluna]); const v = r[pref.medida]; m.set(k, (m.get(k) || 0) + (typeof v === 'number' ? v : 0)); }
      barras = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([label, valor]) => ({ label: label || '(vazio)', valor }));
      $('legenda').textContent = 'Soma de ' + medidaLabel + ' por grupo (página, com o filtro)';
    } else $('legenda').textContent = '';
    const svg = $('grafico'); svg.replaceChildren();
    const max = Math.max(1, ...barras.map((b) => Math.abs(b.valor)));
    const ns = 'http://www.w3.org/2000/svg';
    barras.forEach((b, i) => {
      const w = 320 / Math.max(1, barras.length), h = (Math.abs(b.valor) / max) * 96;
      const rect = document.createElementNS(ns, 'rect');
      rect.setAttribute('x', String(i * w + 4)); rect.setAttribute('y', String(100 - h)); rect.setAttribute('width', String(Math.max(2, w - 8))); rect.setAttribute('height', String(h)); rect.setAttribute('fill', '#7fc4ff');
      const tip = document.createElementNS(ns, 'title'); tip.textContent = b.label + ': ' + fmt(b.valor); rect.appendChild(tip); svg.appendChild(rect);
      const t = document.createElementNS(ns, 'text'); t.setAttribute('x', String(i * w + w / 2)); t.setAttribute('y', '114'); t.setAttribute('text-anchor', 'middle'); t.setAttribute('font-size', '9'); t.setAttribute('fill', '#9cb1cf'); t.textContent = b.label.slice(0, 12); svg.appendChild(t);
    });
    // Tabela: até 20 linhas filtradas e 6 colunas.
    const cols = colunas.slice(0, 6);
    $('cab').replaceChildren(...cols.map((c) => el('th', c.label)));
    $('corpo').replaceChildren(...filtradas.slice(0, 20).map((r) => { const tr = el('tr'); for (const c of cols) tr.appendChild(el('td', txt(r[c.id]), typeof r[c.id] === 'number' ? 'n' : '')); return tr; }));
    // Métricas para Fórmula/Gráfico/outro HTML (validadas pelo host).
    // Política explícita: sem valores numéricos, média = 0 e “valores” = 0. Uma saída não pode ser apagada; quem
    // consome confere “valores”. Assim nenhum valor antigo fica valendo.
    aurora.publish('total', soma);
    aurora.publish('media', media === null ? 0 : media);
    aurora.publish('valores', nums.length);
    aurora.publish('filtradas', filtradas.length);
    aurora.publish('porGrupo', barras);
    aurora.publish('resumo', fmt(filtradas.length) + ' linha(s) filtrada(s); soma de ' + medidaLabel + ': ' + fmt(soma) + '.');
  }
  function save() { aurora.setState({ medida: pref.medida, coluna: pref.coluna, valor: pref.valor }); render(); }
  $('sMedida').onchange = (e) => { pref.medida = e.target.value; save(); };
  $('sColuna').onchange = (e) => { pref.coluna = e.target.value; pref.valor = null; save(); };
  $('sValor').onchange = (e) => { pref.valor = e.target.value ? e.target.value.slice(2) : null; save(); };
  aurora.onInputs((i) => {
    last = { linhas: Array.isArray(i.linhas) ? i.linhas : [], colunas: Array.isArray(i.colunas) ? i.colunas : [], resumo: i.resumo && typeof i.resumo === 'object' ? i.resumo : null, grupos: i.grupos && typeof i.grupos === 'object' ? i.grupos : null };
    render();
  });
</script>`;

/** Portas do dashboard de dados (o “Criar painel HTML conectado” liga rows/columns/summary/groups a elas). */
export const DATASET_DASHBOARD_BRIDGE: BridgeConfig = {
  version: 1,
  inputs: [
    { id: 'linhas', label: 'Linhas (página)', type: 'object' },
    { id: 'colunas', label: 'Colunas', type: 'object' },
    { id: 'resumo', label: 'Resumo', type: 'object' },
    { id: 'grupos', label: 'Agrupamento', type: 'object' },
  ],
  outputs: [
    { id: 'total', label: 'Soma da medida (filtrada)', type: 'number' },
    { id: 'media', label: 'Média da medida (filtrada; 0 sem valores)', type: 'number' },
    { id: 'valores', label: 'Valores numéricos na média', type: 'number' },
    { id: 'filtradas', label: 'Linhas filtradas', type: 'number' },
    { id: 'porGrupo', label: 'Barras do gráfico', type: 'object' },
    { id: 'resumo', label: 'Resumo em texto', type: 'text' },
  ],
  ai,
};
export const DATASET_DASHBOARD_HTML = DATASET_DASHBOARD;

/** H2: dashboard de API pública (GET, sem chave). Não consulta nada ao abrir/importar: só ao clicar em Atualizar. */
export const NET_GITHUB_DASHBOARD = `<style>
  .w{padding:10px;display:flex;flex-direction:column;gap:8px}
  .h{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
  .h input{flex:1;min-width:120px;background:#0f1826;border:1px solid #2a3a52;border-radius:6px;color:#e6ecf6;padding:4px 6px;font:12px ui-monospace,monospace}
  .h button{background:#3174db;border:0;border-radius:6px;color:#fff;padding:5px 10px;font-weight:600;cursor:pointer}
  .h button[disabled]{opacity:.5;cursor:default}
  .k{display:grid;grid-template-columns:repeat(auto-fit,minmax(80px,1fr));gap:6px}
  .c{border:1px solid #2a3a52;border-radius:8px;padding:6px 8px}
  .l{font-size:10px;color:#9cb1cf}.v{font-size:17px;font-weight:700}
  .s{font-size:11px;color:#9cb1cf}.e{color:#ff8a8a}
</style>
<div class="w">
  <div class="h">
    <input id="repo" aria-label="Repositório (dono/nome)" value="LeonardoSSm/aurora-board" />
    <button id="go">Atualizar</button>
  </div>
  <div class="k">
    <div class="c"><div class="l">Estrelas</div><div class="v" id="stars">—</div></div>
    <div class="c"><div class="l">Forks</div><div class="v" id="forks">—</div></div>
    <div class="c"><div class="l">Issues abertas</div><div class="v" id="issues">—</div></div>
  </div>
  <div class="s" id="desc"></div>
  <div class="s" id="status">Clique em Atualizar (pede autorização para api.github.com na primeira vez).</div>
</div>
<script>
  // GET público da API do GitHub (sem chave). A consulta passa pelo Aurora Board: o HTML não tem rede própria.
  const $ = (id) => document.getElementById(id);
  const msgs = {
    permission_denied: 'Acesso negado. Libere em Propriedades → Acesso à rede (ou clique de novo depois de recarregar o bloco).',
    unavailable: 'Acesso à rede indisponível nesta versão (precisa do servidor local).',
    local_only: 'Disponível só no computador principal.',
    rate_limited: 'Muitas consultas: aguarde um minuto.',
    timeout: 'A API demorou demais.',
    sensitive_blocked: 'Bloqueado: este bloco recebe dados protegidos.',
  };
  let ctrl = null;
  async function load() {
    const repo = $('repo').value.trim();
    if (!/^[\\w.-]+\\/[\\w.-]+$/.test(repo)) { $('status').textContent = 'Use o formato dono/nome.'; return; }
    if (ctrl) ctrl.abort();
    ctrl = new AbortController();
    $('go').disabled = true;
    $('status').textContent = 'Consultando…';
    try {
      const r = await aurora.request({ url: 'https://api.github.com/repos/' + repo, responseType: 'json', timeoutMs: 10000, signal: ctrl.signal });
      const d = r.data || {};
      $('stars').textContent = (d.stargazers_count ?? 0).toLocaleString('pt-BR');
      $('forks').textContent = (d.forks_count ?? 0).toLocaleString('pt-BR');
      $('issues').textContent = (d.open_issues_count ?? 0).toLocaleString('pt-BR');
      $('desc').textContent = d.description || '';
      $('status').className = 's';
      $('status').textContent = 'Atualizado às ' + new Date().toLocaleTimeString('pt-BR') + (d.pushed_at ? ' · último push ' + new Date(d.pushed_at).toLocaleDateString('pt-BR') : '');
      aurora.publish('estrelas', d.stargazers_count ?? 0);
      aurora.setState({ repo });
    } catch (e) {
      if (e.code === 'aborted') return;
      $('status').className = 's e';
      $('status').textContent = e.code === 'http_error' && e.status === 404 ? 'Repositório não encontrado (ou privado).' : (msgs[e.code] || e.message);
    } finally {
      $('go').disabled = false;
    }
  }
  $('go').onclick = load;
  addEventListener('aurora:init', (e) => { if (e.detail && e.detail.repo) $('repo').value = e.detail.repo; });
</script>`;

export const BRIDGE_EXAMPLES: BridgeExample[] = [
  { id: 'dataset-dashboard', name: 'Dashboard de dados importados (KPIs, filtro, tabela, gráfico)', html: DATASET_DASHBOARD, bridge: DATASET_DASHBOARD_BRIDGE },
  {
    id: 'net-github',
    name: 'Dashboard público: repositório do GitHub (aurora.request)',
    html: NET_GITHUB_DASHBOARD,
    bridge: { version: 1, inputs: [], outputs: [{ id: 'estrelas', label: 'Estrelas', type: 'number' }], ai },
  },
  {
    id: 'dashboard',
    name: 'Painel: receitas, despesas e saldo',
    html: DASHBOARD,
    bridge: {
      version: 1,
      inputs: [{ id: 'receitas', label: 'Receitas', type: 'money' }, { id: 'despesas', label: 'Despesas', type: 'money' }],
      outputs: [{ id: 'saldo', label: 'Saldo', type: 'money' }, { id: 'resumo', label: 'Resumo', type: 'text' }],
      ai,
    },
  },
  {
    id: 'tasks',
    name: 'Tarefas: contagem e resumo',
    html: TASKS,
    bridge: { version: 1, inputs: [{ id: 'tarefas', label: 'Tarefas', type: 'tasks' }], outputs: [{ id: 'pendentes', label: 'Pendentes', type: 'number' }, { id: 'resumo', label: 'Resumo', type: 'text' }], ai },
  },
  {
    id: 'budget',
    name: 'Meta de gastos (fórmula/gráfico)',
    html: CALC,
    bridge: { version: 1, inputs: [{ id: 'gasto', label: 'Gasto', type: 'money' }], outputs: [{ id: 'uso', label: 'Uso da meta', type: 'percent' }, { id: 'restante', label: 'Restante', type: 'money' }], ai },
  },
];
