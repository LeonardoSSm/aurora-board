import { Calculator, ChartNoAxesCombined, LayoutDashboard } from 'lucide-react';
import { ARTIFACT_SIZE, reviseArtifact, type ArtifactPorts } from '../../core/artifact';
import type { SandboxData } from '../../core/widgetData';
import type { WidgetPreset } from '../registry';

const STYLE = `<style>
  *{box-sizing:border-box} body{color:#eef1fa;background:#131827;font:14px system-ui}
  main{padding:16px;display:grid;gap:12px} h2,p{margin:0} h2{font-size:19px}
  small,figcaption{color:#bfc7db} section{display:flex;flex-wrap:wrap;gap:8px}
  article{flex:1;min-width:90px;background:#1e273a;border:1px solid #34405a;border-radius:9px;padding:10px}
  strong,output{display:block;font-size:20px;color:#d3bbff} label{display:inline-grid;gap:4px}
  input,select{font:inherit;padding:5px 8px;border-radius:6px;border:1px solid #697591;background:#252e44;color:#f4f6fc;max-width:160px}
  figure{margin:0} ul{margin:0;padding-left:20px} progress{accent-color:#b79aff;max-width:100%}
</style>`;

const PROJECTS = `<main>
  <h2>Dashboard de projetos</h2><small id="fonte">Dados fictícios</small>
  <section><article>Projetos ou tarefas<strong id="total"></strong></article><article>Concluídos<strong id="prontos"></strong></article><article>Progresso<strong id="progresso"></strong></article></section>
  <section>
    <label>Status <select id="status"><option value="">Todos</option><option value="todo">A fazer</option><option value="doing">Em andamento</option><option value="done">Concluído</option></select></label>
    <label>Prioridade <select id="prioridade"><option value="">Todas</option><option value="high">Alta</option><option value="medium">Média</option><option value="low">Baixa</option></select></label>
  </section>
  <figure><svg id="grafico" viewBox="0 0 360 24" role="img" aria-label="Distribuição de status" width="100%" height="24"></svg>
  <figcaption id="legenda"></figcaption></figure><ul id="lista"></ul>
</main><script>
  const byId = id => document.getElementById(id);
  const estados = { todo:'A fazer', doing:'Em andamento', done:'Concluído' };
  const prioridades = { high:'Alta', medium:'Média', low:'Baixa' };
  const demo = [
    {text:'Portal Aurora',status:'doing',priority:'high'},
    {text:'Relatórios internos',status:'done',priority:'medium'},
    {text:'Biblioteca de componentes',status:'todo',priority:'low'},
    {text:'Pesquisa de satisfação',status:'done',priority:'high'}
  ];
  const status = byId('status'), prioridade = byId('prioridade');
  status.value = aurora.state?.status || ''; prioridade.value = aurora.state?.prioridade || '';
  function render(i) {
    const pagina = Array.isArray(i.linhas), tarefas = Array.isArray(i.tarefas);
    const rows = (tarefas ? i.tarefas : pagina ? i.linhas : demo).filter(x => x && typeof x === 'object');
    const visiveis = rows.filter(x => (!status.value || x.status === status.value) && (!prioridade.value || x.priority === prioridade.value));
    const feitos = visiveis.filter(x => x.status === 'done').length;
    const progresso = visiveis.length ? feitos / visiveis.length : 0;
    byId('fonte').textContent = tarefas ? 'Tarefas conectadas' : pagina ? 'Página atual dos dados importados' : 'Dados fictícios';
    byId('total').textContent = visiveis.length;
    byId('prontos').textContent = feitos;
    byId('progresso').textContent = Math.round(progresso * 100) + '%';
    byId('lista').replaceChildren(...visiveis.slice(0, 8).map(x => {
      const row = document.createElement('li');
      row.textContent = String(x.text || x.projeto || 'Sem nome') + ' · ' + (estados[x.status] || 'Sem status') + ' · ' + (prioridades[x.priority] || 'Sem prioridade');
      return row;
    }));
    const svg = byId('grafico');
    svg.replaceChildren();
    let start = 0;
    const bins = ['todo','doing','done'].map((key, index) => {
      const count = visiveis.filter(x => x.status === key).length;
      const width = count / Math.max(1, visiveis.length) * 360;
      const bar = document.createElementNS('http://www.w3.org/2000/svg','rect');
      bar.setAttribute('x',start); bar.setAttribute('width',width); bar.setAttribute('height',24);
      bar.setAttribute('fill',['#9caecd','#be9dff','#68d5b3'][index]);
      svg.append(bar); start += width;
      return estados[key] + ' ' + count;
    });
    byId('legenda').textContent = bins.join(' · ');
    aurora.publish('progresso', progresso);
  }
  for (const filtro of [status, prioridade]) filtro.onchange = () => {
    aurora.setState({status:status.value, prioridade:prioridade.value}); render(aurora.inputs);
  };
  aurora.onInputs(render);
</script>`;

const FINANCE = `<main>
  <h2>Dashboard financeiro</h2><small id="fonte">Dados fictícios</small>
  <section><article>Receitas<strong id="receita"></strong></article><article>Despesas<strong id="despesa"></strong></article><article>Saldo<strong id="saldo"></strong></article></section>
  <label>Meta de saldo <input id="meta" type="number" min="1" max="100000000" step="0.01"></label>
  <label>Progresso da meta <progress id="progresso" max="1"></progress></label>
  <p id="nota"></p>
</main><script>
  const byId = id => document.getElementById(id);
  const meta = byId('meta'); meta.value = aurora.state?.meta ?? 2500;
  function render(i) {
    const receita = i.receitas, despesa = i.despesas;
    const conectado = receita || despesa;
    const moeda = receita?.currency || despesa?.currency || 'BRL';
    const mistas = receita && despesa && receita.currency !== despesa.currency;
    const fmt = (value, currency = moeda) => (value / 100).toLocaleString('pt-BR',{style:'currency',currency});
    const entrada = conectado ? receita?.cents ?? 0 : 650000;
    const saida = conectado ? Math.abs(despesa?.cents ?? 0) : 430000;
    const saldo = entrada - saida;
    const alvo = Math.round(Number(meta.value) * 100);
    byId('fonte').textContent = conectado ? 'Valores conectados ao Board' : 'Dados fictícios';
    byId('receita').textContent = fmt(entrada, receita?.currency || moeda);
    byId('despesa').textContent = fmt(saida, despesa?.currency || moeda);
    const completo = !conectado || Boolean(receita && despesa);
    byId('saldo').textContent = mistas || !completo ? '—' : fmt(saldo);
    byId('progresso').value = mistas || !completo || !alvo ? 0 : Math.min(1, Math.max(0, saldo/alvo));
    byId('nota').textContent = mistas ? 'Moedas diferentes. O saldo requer a mesma moeda.' : !completo ? 'Conecte receitas e despesas para calcular o saldo.' : 'Meta em ' + moeda;
    aurora.publish('saldoCalculado', !mistas && completo);
    aurora.publish('saldo', { cents: mistas || !completo ? 0 : saldo, currency: moeda });
  }
  meta.onchange = () => {
    if (meta.validity.valid && meta.value) aurora.setState({meta:Number(meta.value)});
    render(aurora.inputs);
  };
  aurora.onInputs(render);
</script>`;

const CALCULATOR = `<main>
  <h2>Calculadora de cenários</h2><small>Valores iniciais fictícios. Você pode editar os campos.</small>
  <section>
    <label>Valor base <input id="base" type="number" min="0" max="1000000" step="0.01"></label>
    <label>Taxa (%) <input id="taxa" type="number" min="-100" max="1000" step="0.01"></label>
  </section>
  <article><label>Resultado <output id="resultado"></output></label></article>
</main><script>
  const base = document.getElementById('base'), taxa = document.getElementById('taxa'), resultado = document.getElementById('resultado');
  base.value = aurora.state?.base ?? 100;
  taxa.value = aurora.state?.taxa ?? 15;
  function render() {
    if (!base.value || !taxa.value || !base.validity.valid || !taxa.validity.valid) {
      resultado.textContent = 'Preencha valores válidos';
      aurora.publish('valido', false);
      aurora.publish('resultado', 0);
      return;
    }
    const value = Number((Number(base.value) * (1 + Number(taxa.value)/100)).toFixed(2));
    resultado.textContent = value.toLocaleString('pt-BR',{minimumFractionDigits:2,maximumFractionDigits:2});
    aurora.publish('valido', true);
    aurora.publish('resultado', value);
  }
  for (const field of [base, taxa]) field.oninput = render;
  for (const field of [base, taxa]) field.onchange = () => {
    if (base.validity.valid && taxa.validity.valid && base.value && taxa.value) aurora.setState({base:Number(base.value),taxa:Number(taxa.value)});
  };
  render();
</script>`;

function preset(id: string, name: string, icon: WidgetPreset['icon'], code: string, ports: ArtifactPorts): WidgetPreset<SandboxData> {
  return { id, name, icon, keywords: ['artifact', 'exemplo', 'html'], accent: '#b998ff', size: ARTIFACT_SIZE,
    data: reviseArtifact({ html: '', state: null }, STYLE + code, ports, 'example', false) };
}

export const ARTIFACT_EXAMPLES = [
  preset('artifact-projects', 'Dashboard de projetos', LayoutDashboard, PROJECTS, {
    inputs: [{ id: 'tarefas', label: 'Tarefas', type: 'tasks' }, { id: 'linhas', label: 'Página de projetos', type: 'object' }],
    outputs: [{ id: 'progresso', label: 'Progresso filtrado', type: 'percent' }],
  }),
  preset('artifact-finance', 'Dashboard financeiro', ChartNoAxesCombined, FINANCE, {
    inputs: [{ id: 'receitas', label: 'Receitas', type: 'money' }, { id: 'despesas', label: 'Despesas', type: 'money' }],
    outputs: [{ id: 'saldo', label: 'Saldo', type: 'money' }, { id: 'saldoCalculado', label: 'Saldo calculado', type: 'boolean' }],
  }),
  preset('artifact-calculator', 'Calculadora de cenários', Calculator, CALCULATOR, {
    inputs: [], outputs: [{ id: 'resultado', label: 'Resultado', type: 'number' }, { id: 'valido', label: 'Resultado válido', type: 'boolean' }],
  }),
];
