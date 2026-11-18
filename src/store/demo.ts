/** Quadro de demonstração criado na primeira execução (pode ser excluído livremente). */
import type { AuroraElement, Board, LinkKind } from '../core/schema';
import { createBoard, createLinear, createShape, createText, createWidget, uid, FONT_SIZES } from '../core/elements';
import { updateBoundArrows } from '../core/bindings';
import { fitTextElement } from '../core/text';
import { WIDGET } from '../core/widgetIds';
import { connectionStyle } from '../core/connectionStyle';

function connect(from: AuroraElement, to: AuroraElement, kind: LinkKind, label = '') {
  const st = connectionStyle(kind);
  const a = createLinear('arrow', 0, 0, [[0, 0], [1, 1]], { roughness: 0, strokeColor: st.stroke, strokeStyle: st.dash }, kind);
  a.startBinding = { elementId: from.id, fixedPoint: null };
  a.endBinding = { elementId: to.id, fixedPoint: null };
  a.text = label;
  return a;
}

export function buildDemoBoard(workspaceId: string): Board {
  const b = createBoard(workspaceId, 'Demonstração', 'Exemplo com formas, conexões e blocos funcionais conectados por dados.');
  const month = new Date().toISOString().slice(0, 7);
  const els: AuroraElement[] = [];

  const title = fitTextElement(createText(0, -90, 'Aurora Board — demonstração', { fontSize: FONT_SIZES.XL, strokeColor: '#e6e9f4', textAlign: 'left' }));
  const idea = createShape('rectangle', 0, 0, 180, 90, { strokeColor: '#69a8ff', backgroundColor: '#24436a' });
  idea.text = 'Ideia';
  const validate = createShape('ellipse', 280, 0, 180, 90, { strokeColor: '#b998ff', backgroundColor: '#40335e' });
  validate.text = 'Validar';
  const decide = createShape('diamond', 560, -10, 170, 110, { strokeColor: '#f3c577' });
  decide.text = 'Decidir?';
  const sticky = createShape('sticky', 0, 150, 260, 150);
  sticky.text = 'Duplo clique numa forma para escrever.\nArraste as formas: as setas acompanham.\nCtrl+Z desfaz.';
  els.push(title, idea, validate, decide, sticky, connect(idea, validate, 'visual'), connect(validate, decide, 'visual'));

  const salary = createWidget(WIDGET.finance, '1.0.0', 'Salário', 0, 380, 340, 330, {
    currency: 'BRL', period: 'all', format: 'currency', includeInputs: true,
    entries: [{ id: uid(), description: 'Salário', amountCents: 500000, kind: 'income', category: 'Renda', date: `${month}-05`, paid: true, installments: 1, installmentMode: 'split' }],
  });
  const expenses = createWidget(WIDGET.finance, '1.0.0', 'Despesas do mês', 440, 380, 360, 440, {
    currency: 'BRL', period: month, format: 'currency', includeInputs: true,
    entries: [
      { id: uid(), description: 'Aluguel', amountCents: 180000, kind: 'expense', category: 'Moradia', date: `${month}-10`, paid: false, installments: 1, installmentMode: 'split' },
      { id: uid(), description: 'Mercado', amountCents: 90000, kind: 'expense', category: 'Alimentação', date: `${month}-15`, paid: false, installments: 1, installmentMode: 'split' },
      { id: uid(), description: 'Notebook', amountCents: 360000, kind: 'expense', category: 'Equipamentos', date: `${month}-20`, paid: false, installments: 3, installmentMode: 'split' },
    ],
  });
  const chart = createWidget(WIDGET.chart, '1.0.0', 'Gastos por categoria', 900, 380, 360, 300, { mode: 'categories', chartType: 'bar' });
  for (const w of [salary, expenses]) w.style.strokeColor = '#5addaa';
  chart.style.strokeColor = '#b998ff';
  els.push(salary, expenses, chart, connect(salary, expenses, 'data', 'saldo'), connect(expenses, chart, 'data'));

  const notes = createWidget(WIDGET.notes, '1.0.0', 'Projeto', 840, -110, 320, 230, {
    markdown: '# Lançamento\n- Definir público\n- Produzir conteúdo\n- Medir retenção\n\nVeja [o README](https://github.com) para detalhes.',
    mode: 'preview',
  });
  notes.style.strokeColor = '#f3c577';
  const tasks = createWidget(WIDGET.tasks, '1.0.0', 'Próximos passos', 1240, -110, 320, 260, {
    hideDone: false,
    items: [
      { id: uid(), text: 'Escolher nicho inicial', status: 'done', priority: 'high', dueDate: '' },
      { id: uid(), text: 'Produzir o primeiro vídeo', status: 'doing', priority: 'medium', dueDate: '' },
      { id: uid(), text: 'Avaliar métricas', status: 'todo', priority: 'medium', dueDate: '' },
    ],
  });
  tasks.style.strokeColor = '#5addaa';
  const ai = createWidget(WIDGET.ai, '1.0.0', 'Assistente de estratégia', 1360, 330, 380, 480, {
    instruction: 'Analise o projeto conectado e sugira os próximos passos.',
  });
  ai.style.strokeColor = '#b998ff';
  els.push(notes, tasks, ai, connect(notes, ai, 'context'), connect(tasks, ai, 'context'));

  b.elements = updateBoundArrows(els);
  b.camera = { x: 120, y: 160, zoom: 0.6 };
  return b;
}
