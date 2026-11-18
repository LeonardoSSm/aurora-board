import { describe, expect, it } from 'vitest';
import { computeFinance, emptyFinance, expandEntry, formatMoney, parseMoney, sanitizeFinance, type FinanceEntry } from '../../src/core/finance';

const entry = (p: Partial<FinanceEntry>): FinanceEntry => ({
  id: Math.random().toString(36),
  description: 'x',
  amountCents: 0,
  kind: 'expense',
  category: '',
  date: '',
  paid: false,
  installments: 1,
  installmentMode: 'split',
  ...p,
});

describe('parseMoney', () => {
  it.each([
    ['1.234,56', 123456],
    ['1234.56', 123456],
    ['1234,5', 123450],
    ['-125,50', -12550],
    ['R$ 10', 1000],
    ['1.234', 123400],
    ['1.234.567', 123456700],
    ['0.5', 50],
    ['12.5', 1250],
    ['1,234.56', 123456],
    ['0,01', 1],
  ])('%s → %i centavos', (input, cents) => {
    expect(parseMoney(input)).toBe(cents);
  });

  it.each(['', 'abc', '1.23.4', '--'])('rejeita "%s"', (input) => {
    expect(parseMoney(input)).toBeNull();
  });
});

describe('cálculos financeiros', () => {
  it('soma em centavos sem erro de ponto flutuante', () => {
    const d = { ...emptyFinance(), entries: [entry({ kind: 'income', amountCents: 10 }), entry({ kind: 'income', amountCents: 20 })] };
    expect(computeFinance(d).summary.incomeCents).toBe(30); // 0,10 + 0,20 = 0,30 exato
  });

  it('saldo = receitas − despesas; realizado considera apenas pagos', () => {
    const d = {
      ...emptyFinance(),
      entries: [
        entry({ kind: 'income', amountCents: 500000, paid: true }),
        entry({ kind: 'expense', amountCents: 180000, paid: true }),
        entry({ kind: 'expense', amountCents: 90000, paid: false }),
      ],
    };
    const r = computeFinance(d);
    expect(r.summary.balanceCents).toBe(230000);
    expect(r.summary.realizedCents).toBe(320000);
    expect(r.summary.pendingCents).toBe(-90000);
  });

  it('parcelamento dividido distribui centavos restantes nas primeiras parcelas', () => {
    const occ = expandEntry(entry({ amountCents: 10000, installments: 3, date: '2026-01-31' }));
    expect(occ.map((o) => o.amountCents)).toEqual([3334, 3333, 3333]);
    expect(occ.reduce((s, o) => s + o.amountCents, 0)).toBe(10000);
    // vencimento ajustado ao fim do mês
    expect(occ.map((o) => o.date)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31']);
    expect(occ.map((o) => `${o.index}/${o.count}`)).toEqual(['1/3', '2/3', '3/3']);
  });

  it('parcelamento "repeat" usa valor por parcela', () => {
    const occ = expandEntry(entry({ amountCents: 5000, installments: 4, installmentMode: 'repeat', date: '2026-11-10' }));
    expect(occ.reduce((s, o) => s + o.amountCents, 0)).toBe(20000);
    expect(occ[3].date).toBe('2027-02-10');
  });

  it('filtro por período considera somente parcelas do mês', () => {
    const d = { ...emptyFinance(), period: '2026-02', entries: [entry({ amountCents: 30000, installments: 3, date: '2026-01-15' }), entry({ amountCents: 999, date: '' })] };
    const r = computeFinance(d);
    expect(r.summary.expenseCents).toBe(10000);
    expect(r.occurrences).toHaveLength(1);
  });

  it('entradas por conexão somam ao saldo (salário → despesas)', () => {
    const salary = { ...emptyFinance(), entries: [entry({ kind: 'income', amountCents: 500000 })] };
    const sSalary = computeFinance(salary, [], 'Salário').summary;
    const expenses = { ...emptyFinance(), entries: [entry({ amountCents: 180000 }), entry({ amountCents: 90000 })] };
    const r = computeFinance(expenses, [sSalary], 'Despesas');
    expect(r.summary.inputCents).toBe(500000);
    expect(r.summary.balanceCents).toBe(230000);
    expect(r.inputs[0].source).toBe('Salário');
  });

  it('moeda diferente na entrada não é somada e gera aviso', () => {
    const usd = computeFinance({ ...emptyFinance('USD'), entries: [entry({ kind: 'income', amountCents: 1000 })] }, [], 'USD').summary;
    const r = computeFinance({ ...emptyFinance('BRL'), entries: [] }, [usd]);
    expect(r.summary.inputCents).toBe(0);
    expect(r.warnings[0]).toMatch(/USD/);
  });

  it('desativar entradas ignora conexões', () => {
    const inp = computeFinance({ ...emptyFinance(), entries: [entry({ kind: 'income', amountCents: 100 })] }).summary;
    const r = computeFinance({ ...emptyFinance(), includeInputs: false }, [inp]);
    expect(r.summary.balanceCents).toBe(0);
  });

  it('formatação em diferentes formatos', () => {
    expect(formatMoney(123456, 'BRL')).toMatch(/R\$\s?1\.234,56/);
    expect(formatMoney(123456, 'BRL', 'plain')).toBe('1.234,56');
    expect(formatMoney(-50, 'USD')).toMatch(/-\$0\.50|\$-0\.50|−\$0\.50/);
  });

  it('saneamento de dados inválidos', () => {
    const d = sanitizeFinance({ currency: 'XXX', entries: [{ amountCents: -500, kind: 'weird', installments: 0 }, null] });
    expect(d.currency).toBe('BRL');
    expect(d.entries).toHaveLength(1);
    expect(d.entries[0].amountCents).toBe(500);
    expect(d.entries[0].kind).toBe('expense');
    expect(d.entries[0].installments).toBe(1);
  });
});
