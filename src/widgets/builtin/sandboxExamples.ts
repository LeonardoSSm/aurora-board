/** Exemplos editáveis da ponte de dados (issue #11). Só usam a API documentada; nenhum acessa rede. */
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

export const BRIDGE_EXAMPLES: BridgeExample[] = [
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
