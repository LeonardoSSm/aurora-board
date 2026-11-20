/** Ciclo F1 — parsing monetário, datas, CSV e OFX (dados 100% fictícios). */
import { describe, expect, it } from 'vitest';
import { detectDateOrder, detectDecimalSeparator, parseBankAmount, parseBankDate } from '../../src/finance/parsing';
import { csvSafeCell, detectDelimiter, parseCsv, parseCsvStatement, StatementError, suggestMapping, toCsv } from '../../src/finance/csv';
import { decodeStatementBytes, parseOfxStatements } from '../../src/finance/ofx';
import { cleanText, maskIdentifier } from '../../src/finance/model';

describe('parseBankAmount', () => {
  it('vírgula decimal (pt-BR)', () => {
    expect(parseBankAmount('1.234,56', ',')).toBe(123456);
    expect(parseBankAmount('-1.234,56', ',')).toBe(-123456);
    expect(parseBankAmount('R$ 10,5', ',')).toBe(1050);
    expect(parseBankAmount('(50,00)', ',')).toBe(-5000);
    expect(parseBankAmount('123,45-', ',')).toBe(-12345);
    expect(parseBankAmount('123,45 D', ',')).toBe(-12345);
    expect(parseBankAmount('123,45 C', ',')).toBe(12345);
    expect(parseBankAmount('1234', ',')).toBe(123400);
    expect(parseBankAmount('1.234.567,89', ',')).toBe(123456789);
  });
  it('ponto decimal', () => {
    expect(parseBankAmount('1,234.56', '.')).toBe(123456);
    expect(parseBankAmount('-0.1', '.')).toBe(-10);
    expect(parseBankAmount('0.01', '.')).toBe(1);
  });
  it('recusa ambiguidades e lixo (nunca adivinha centavos)', () => {
    expect(parseBankAmount('1,234', ',')).toBeNull(); // 3 casas com vírgula decimal
    expect(parseBankAmount('12.34', ',')).toBeNull(); // grupo de milhar inválido
    expect(parseBankAmount('1.2.3', '.')).toBeNull();
    expect(parseBankAmount('abc', ',')).toBeNull();
    expect(parseBankAmount('', ',')).toBeNull();
    expect(parseBankAmount('=1+1', ',')).toBeNull();
    expect(parseBankAmount('99999999999999999999,00', ',')).toBeNull(); // acima do limite
    expect(parseBankAmount('1e5', '.')).toBeNull();
  });
  it('0,1 + 0,2 em centavos é exato', () => {
    expect(parseBankAmount('0,10', ',')! + parseBankAmount('0,20', ',')!).toBe(30);
  });
  it('detecta o separador decimal', () => {
    expect(detectDecimalSeparator(['1.234,56', '-10,00'])).toBe(',');
    expect(detectDecimalSeparator(['1,234.56', '-10.00'])).toBe('.');
    expect(detectDecimalSeparator(['1.234'])).toBeNull(); // ambíguo
  });
});

describe('parseBankDate', () => {
  it('formatos brasileiros, ISO e OFX, sem fuso', () => {
    expect(parseBankDate('31/12/2026')).toBe('2026-12-31');
    expect(parseBankDate('01-02-26')).toBe('2026-02-01');
    expect(parseBankDate('2026-12-31')).toBe('2026-12-31');
    expect(parseBankDate('2026-12-31T23:59:59-03:00')).toBe('2026-12-31'); // data civil preservada
    expect(parseBankDate('20261231')).toBe('2026-12-31');
    expect(parseBankDate('20261231235959[-3:BRT]')).toBe('2026-12-31');
    expect(parseBankDate('20261231120000.000')).toBe('2026-12-31');
  });
  it('recusa datas impossíveis', () => {
    expect(parseBankDate('31/02/2026')).toBeNull();
    expect(parseBankDate('29/02/2027')).toBeNull();
    expect(parseBankDate('29/02/2028')).toBe('2028-02-29');
    expect(parseBankDate('2026-13-01')).toBeNull();
    expect(parseBankDate('ontem')).toBeNull();
  });
  it('ordem dia/mês detectada', () => {
    expect(detectDateOrder(['12/25/2026'])).toBe('mdy');
    expect(detectDateOrder(['25/12/2026'])).toBe('dmy');
    expect(parseBankDate('12/25/2026', 'mdy')).toBe('2026-12-25');
  });
});

describe('CSV', () => {
  it('RFC 4180: aspas, aspas duplicadas, quebra de linha em campo, BOM e CRLF', () => {
    const { rows } = parseCsv('﻿a;b\r\n"x;1";"diz ""oi""\nlinha 2"\r\n', ';');
    expect(rows).toEqual([['a', 'b'], ['x;1', 'diz "oi"\nlinha 2']]);
  });
  it('aspas não fechadas são recusadas', () => {
    expect(() => parseCsv('a;"b\n', ';')).toThrow(StatementError);
  });
  it('detecta delimitador ; e ,', () => {
    expect(detectDelimiter('Data;Descrição;Valor\n01/01/2026;X;1,00\n')).toBe(';');
    expect(detectDelimiter('date,description,amount\n2026-01-01,X,1.00\n')).toBe(',');
  });
  it('extrato com preâmbulo, vírgula decimal, colunas desconhecidas e linha de saldo', () => {
    const csv = [
      'Banco Fictício S.A.;;;',
      'Conta: 0001-2;;;',
      'Data;Histórico;Valor;Coluna Estranha;Saldo',
      '01/11/2026;SALDO ANTERIOR;;x;1.000,00',
      '05/11/2026;PIX RECEBIDO FULANO;2.000,00;y;3.000,00',
      '06/11/2026;"MERCADO; CENTRO";-123,45;z;2.876,55',
      '07/11/2026;TARIFA PACOTE;-12,90;;2.863,65',
    ].join('\n');
    const r = parseCsvStatement(csv);
    expect(r.mapping.headerRow).toBe(2);
    expect(r.mapping.decimalSep).toBe(',');
    expect(r.drafts.map((d) => d.amountCents)).toEqual([200000, -12345, -1290]);
    expect(r.drafts[1].description).toBe('MERCADO; CENTRO');
    expect(r.ignored).toHaveLength(1);
    expect(r.range).toEqual({ from: '2026-11-05', to: '2026-11-07' });
  });
  it('ponto decimal, datas ISO e colunas crédito/débito separadas', () => {
    const csv = 'date,description,credit,debit,id\n2026-11-01,Salary,"2,000.00",,A1\n2026-11-02,Coffee,,4.50,A2\n';
    const r = parseCsvStatement(csv);
    expect(r.mapping.decimalSep).toBe('.');
    expect(r.drafts.map((d) => [d.amountCents, d.externalId])).toEqual([[200000, 'A1'], [-450, 'A2']]);
  });
  it('linhas inválidas são listadas sem interromper a importação', () => {
    const csv = 'Data;Descrição;Valor\n32/01/2026;X;1,00\n01/01/2026;Y;abc\n02/01/2026;Z;-5,00\n';
    const r = parseCsvStatement(csv);
    expect(r.drafts).toHaveLength(1);
    expect(r.invalid.map((i) => i.line)).toEqual([2, 3]);
    expect(r.invalid[0].reason).toMatch(/Data inválida/);
  });
  it('arquivo vazio e sem colunas reconhecíveis', () => {
    expect(() => parseCsvStatement('')).toThrow(/vazio/);
    expect(() => parseCsvStatement('   \n  ')).toThrow(/vazio/);
    expect(() => parseCsvStatement('foo;bar\nbaz;qux\n')).toThrow(StatementError);
  });
  it('mapeamento manual: inverter sinal de fatura de cartão', () => {
    const csv = 'date,title,amount\n2026-11-03,Loja X,300.00\n2026-11-10,Estorno Loja X,-50.00\n';
    const base = parseCsvStatement(csv);
    const r = parseCsvStatement(csv, { mapping: { ...base.mapping, invertSign: true } });
    expect(r.drafts.map((d) => d.amountCents)).toEqual([-30000, 5000]);
  });
  it('limites: linhas, colunas e tamanho de campo', () => {
    expect(() => parseCsv('a\n'.repeat(20), ';', { maxBytes: 1e6, maxRows: 10, maxColumns: 5, maxFieldChars: 100 })).toThrow(/linhas/);
    expect(() => parseCsv('a;'.repeat(10), ';', { maxBytes: 1e6, maxRows: 10, maxColumns: 5, maxFieldChars: 100 })).toThrow(/colunas/);
    expect(() => parseCsv('x'.repeat(200), ';', { maxBytes: 1e6, maxRows: 10, maxColumns: 5, maxFieldChars: 100 })).toThrow(/caracteres/);
  });
  it('arquivo grande (20.000 linhas) é lido sem truncar', () => {
    const lines = ['Data;Descrição;Valor'];
    for (let i = 0; i < 20_000; i++) lines.push(`${String((i % 28) + 1).padStart(2, '0')}/10/2026;Compra ${i};-${(i % 500) + 1},${String(i % 100).padStart(2, '0')}`);
    const r = parseCsvStatement(lines.join('\n'));
    expect(r.drafts).toHaveLength(20_000);
    expect(r.invalid).toHaveLength(0);
  });
  it('sugere mapeamento por sinônimos', () => {
    const m = suggestMapping([['Data Lançamento', 'Descrição', 'Valor (R$)', 'Saldo (R$)', 'Categoria']]);
    expect(m.columns).toMatchObject({ date: 0, description: 1, amount: 2, balance: 3, category: 4 });
  });
});

describe('Exportação CSV segura (injeção de fórmulas)', () => {
  it('neutraliza =, +, -, @ em texto, mantém números', () => {
    expect(csvSafeCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvSafeCell('+SOMA(A1)')).toBe("'+SOMA(A1)");
    expect(csvSafeCell('@cmd')).toBe("'@cmd");
    expect(csvSafeCell('-123,45')).toBe('"-123,45"');
    expect(csvSafeCell(-12345)).toBe('-12345');
    expect(toCsv([['a', '=1+1']]).startsWith('﻿')).toBe(true);
  });
});

const OFX_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0<SEVERITY>INFO</STATUS><DTSERVER>20261130120000[-3:BRT]<LANGUAGE>POR<FI><ORG>Banco Ficticio<FID>999</FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><TRNUID>1<STATUS><CODE>0<SEVERITY>INFO</STATUS>
<STMTRS><CURDEF>BRL
<BANKACCTFROM><BANKID>999<BRANCHID>0001<ACCTID>123456789<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261101000000[-3:BRT]<DTEND>20261130000000[-3:BRT]
<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20261105000000[-3:BRT]<TRNAMT>2000.00<FITID>F001<MEMO>SALARIO EMPRESA FICTICIA</STMTTRN>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261106000000[-3:BRT]<TRNAMT>-123.45<FITID>F002<NAME>MERCADO &amp; CIA</STMTTRN>
<STMTTRN><TRNTYPE>FEE<DTPOSTED>20261107<TRNAMT>-12,90<FITID>F003<MEMO>TARIFA</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>1863.65<DTASOF>20261130</LEDGERBAL>
<AVAILBAL><BALAMT>1800.00<DTASOF>20261130</AVAILBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1>
</OFX>`;

describe('OFX', () => {
  it('SGML 1.x: conta mascarada, FITID, saldo informado, vírgula tolerada, entidades', () => {
    const [s] = parseOfxStatements(OFX_SGML);
    expect(s.account).toMatchObject({ kind: 'bank', institutionCode: '999', maskedNumber: '•••• 6789', currency: 'BRL', institutionName: 'Banco Ficticio' });
    expect(s.drafts.map((d) => [d.externalId, d.postedDate, d.amountCents, d.rawType])).toEqual([
      ['F001', '2026-11-05', 200000, 'CREDIT'],
      ['F002', '2026-11-06', -12345, 'DEBIT'],
      ['F003', '2026-11-07', -1290, 'FEE'],
    ]);
    expect(s.drafts[1].description).toBe('MERCADO & CIA');
    expect(s.reportedBalance).toEqual({ cents: 186365, asOf: '2026-11-30', availableCents: 180000 });
    expect(s.range).toEqual({ from: '2026-11-01', to: '2026-11-30' });
    expect(JSON.stringify(s)).not.toContain('123456789'); // número completo nunca sai do parser
  });
  it('XML 2.x de cartão (CCSTMTRS)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?><?OFX OFXHEADER="200" VERSION="220"?>
<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL</CURDEF><CCACCTFROM><ACCTID>5555444433332222</ACCTID></CCACCTFROM>
<BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261103</DTPOSTED><TRNAMT>-300.00</TRNAMT><FITID>C1</FITID><NAME>Loja Ficticia</NAME></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261120</DTPOSTED><TRNAMT>300.00</TRNAMT><FITID>C2</FITID><NAME>Pagamento recebido</NAME></STMTTRN></BANKTRANLIST>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;
    const [s] = parseOfxStatements(xml);
    expect(s.account?.kind).toBe('card');
    expect(s.account?.maskedNumber).toBe('•••• 2222');
    expect(s.drafts.map((d) => d.amountCents)).toEqual([-30000, 30000]);
  });
  it('recusa DOCTYPE/ENTITY (XXE), arquivos sem extrato e lixo', () => {
    expect(() => parseOfxStatements('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><OFX>&e;</OFX>')).toThrow(/DOCTYPE|ENTITY/);
    expect(() => parseOfxStatements('OFXHEADER:100\n<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>')).toThrow(/Nenhum extrato/);
    expect(() => parseOfxStatements('isto não é ofx')).toThrow(/não parece/);
    expect(() => parseOfxStatements('')).toThrow(/vazio/);
  });
  it('OFX malformado: movimentação com valor/data inválidos vira erro listado, não dado errado', () => {
    const bad = OFX_SGML.replace('<TRNAMT>-123.45', '<TRNAMT>-12.3.45').replace('<DTPOSTED>20261107', '<DTPOSTED>20261340');
    const [s] = parseOfxStatements(bad);
    expect(s.drafts.map((d) => d.externalId)).toEqual(['F001']);
    expect(s.invalid).toHaveLength(2);
  });
  it('moeda não suportada é recusada', () => {
    expect(() => parseOfxStatements(OFX_SGML.replace('<CURDEF>BRL', '<CURDEF>JPY'))).toThrow(/não suportada/);
  });
  it('profundidade excessiva é recusada', () => {
    const deep = 'OFXHEADER:100\n<OFX>' + '<A>'.repeat(60) + '</OFX>';
    expect(() => parseOfxStatements(deep)).toThrow(/profundo|Nenhum extrato/);
  });
  it('decodifica Windows-1252 declarado e UTF-8', () => {
    const latin = new Uint8Array([...new TextEncoder().encode('CHARSET:1252\n<OFX>'), 0xc7, 0xc3, 0x4f]);
    expect(decodeStatementBytes(latin)).toContain('ÇÃO');
    expect(decodeStatementBytes(new TextEncoder().encode('Descrição'))).toBe('Descrição');
  });
});

describe('higiene de dados', () => {
  it('mascara identificadores e remove controles/bidi', () => {
    expect(maskIdentifier('12345-6')).toBe('•••• 3456');
    expect(maskIdentifier('')).toBe('');
    expect(cleanText('a\u0000b‮c\n d')).toBe('a b c d');
  });
});
