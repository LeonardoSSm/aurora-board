/**
 * Data Hub (issue #24, D2-C) — conjunto de exemplo 100% FICTÍCIO (vendas de uma loja inventada), para conhecer
 * importação, dashboards e agregações sem usar dados reais. Gerado de forma determinística (mesmos valores sempre).
 */
export const SAMPLE_DATASET_NAME = 'vendas-exemplo-ficticio';

const MESES = ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06'];
const REGIOES = ['Norte', 'Nordeste', 'Centro-Oeste', 'Sudeste', 'Sul'];
const PRODUTOS = ['Café especial', 'Chá verde', 'Bolo de fubá', 'Pão de queijo'];

function build(): string {
  const lines = ['mes,regiao,produto,unidades,receita'];
  let seed = 7;
  const next = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
  for (const mes of MESES) {
    for (const regiao of REGIOES) {
      for (const produto of PRODUTOS) {
        const unidades = 10 + Math.floor(next() * 90);
        const preco = 8 + Math.floor(next() * 30);
        lines.push(`${mes},${regiao},${produto},${unidades},${(unidades * preco).toFixed(2)}`);
      }
    }
  }
  return lines.join('\n') + '\n';
}

/** 120 linhas × 5 colunas (mês, região, produto, unidades, receita). */
export const SAMPLE_DATASET_CSV = build();
