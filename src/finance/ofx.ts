/**
 * Leitor OFX 1.x (SGML) e 2.x (XML) — próprio, sem DOMParser nem bibliotecas XML.
 *
 * Segurança: recusa `<!DOCTYPE`/`<!ENTITY` (nada de entidades externas), decodifica só as entidades básicas e
 * numéricas, não busca nada na rede, limita tamanho, profundidade, nós e transações. Formatos que não
 * conseguimos ler com segurança são RECUSADOS com mensagem clara — nunca geram dados aproximados.
 */
import type { Currency } from '../core/finance';
import { cleanText, maskIdentifier } from './model';
import { parseBankAmount, parseBankDate } from './parsing';
import { rangeOf, type InvalidRow, type ParsedStatement, type TransactionDraft } from './drafts';
import { StatementError } from './csv';

export const OFX_LIMITS = { maxBytes: 20 * 1024 * 1024, maxDepth: 32, maxNodes: 600_000, maxTransactions: 100_000 };

interface OfxNode { tag: string; value?: string; children: OfxNode[] }

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp);/gi, (_, e: string) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&';
    if (k === 'lt') return '<';
    if (k === 'gt') return '>';
    if (k === 'quot') return '"';
    if (k === 'apos') return "'";
    if (k === 'nbsp') return ' ';
    const code = k.startsWith('#x') ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return code > 0 && code < 0x110000 && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  });
}

export function looksLikeOfx(text: string): boolean {
  const head = text.slice(0, 4000).toUpperCase();
  return head.includes('OFXHEADER') || head.includes('<OFX>') || head.includes('<OFX ');
}

/** Árvore tolerante a elementos SGML sem fechamento (`<TRNAMT>-10.00`). */
export function parseOfxTree(text: string, limits = OFX_LIMITS): OfxNode {
  if (text.length > limits.maxBytes) throw new StatementError(`Arquivo grande demais (limite de ${limits.maxBytes / 1024 / 1024} MB).`);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new StatementError('OFX com DOCTYPE/ENTITY recusado por segurança.');
  const start = text.search(/<OFX[\s>]/i);
  if (start < 0) throw new StatementError('Arquivo OFX sem o bloco <OFX>.');
  const body = text.slice(start);
  const root: OfxNode = { tag: '#root', children: [] };
  const stack: OfxNode[] = [root];
  const tokens = body.matchAll(/<(\/?)([A-Za-z0-9_.]+)(?:\s[^>]*)?>|([^<]+)/g);
  let nodes = 0;
  let pendingLeaf: OfxNode | null = null; // aberto, aguardando saber se é folha (texto) ou agregado
  for (const m of tokens) {
    if (m[3] !== undefined) {
      const txt = m[3].trim();
      if (!txt) continue;
      if (pendingLeaf) { pendingLeaf.value = decodeEntities(txt); pendingLeaf = null; }
      continue;
    }
    const closing = m[1] === '/';
    const tag = m[2].toUpperCase();
    if (closing) {
      if (pendingLeaf && pendingLeaf.tag === tag) { pendingLeaf = null; continue; }
      pendingLeaf = null;
      // Fecha até o agregado correspondente (tolerante a folhas SGML sem fechamento).
      const idx = stack.map((n) => n.tag).lastIndexOf(tag);
      if (idx > 0) stack.length = idx;
      continue;
    }
    if (++nodes > limits.maxNodes) throw new StatementError('OFX com estrutura grande demais.');
    // Uma nova tag: se a anterior ficou sem texto, era agregado — vira pai.
    if (pendingLeaf) {
      stack.push(pendingLeaf);
      if (stack.length > limits.maxDepth) throw new StatementError('OFX com aninhamento profundo demais.');
      pendingLeaf = null;
    }
    const node: OfxNode = { tag, children: [] };
    stack[stack.length - 1].children.push(node);
    pendingLeaf = node;
  }
  const ofx = root.children.find((n) => n.tag === 'OFX');
  if (!ofx) throw new StatementError('Arquivo OFX malformado.');
  return ofx;
}

function child(n: OfxNode | undefined, tag: string): OfxNode | undefined {
  return n?.children.find((c) => c.tag === tag);
}
function val(n: OfxNode | undefined, tag: string): string | undefined {
  const c = child(n, tag);
  return c?.value?.trim() || undefined;
}
function findAll(n: OfxNode, tag: string, out: OfxNode[] = [], depth = 0): OfxNode[] {
  if (depth > 40) return out;
  for (const c of n.children) {
    if (c.tag === tag) out.push(c);
    else findAll(c, tag, out, depth + 1);
  }
  return out;
}

function ofxAmount(s: string | undefined): number | null {
  if (!s) return null;
  const t = s.trim();
  // A especificação usa ponto; alguns bancos brasileiros emitem vírgula.
  if (/^[-+]?\d+(\.\d{1,2})?$/.test(t)) return parseBankAmount(t, '.');
  if (/^[-+]?\d+,\d{1,2}$/.test(t)) return parseBankAmount(t, ',');
  if (/^[-+]?\d+\.\d{3,}$/.test(t)) {
    // Mais de 2 casas: aceita só se os dígitos extras forem zero (ex.: "-50.000" = -50,00).
    const [i, f] = t.split('.');
    if (/^0+$/.test(f.slice(2))) return parseBankAmount(`${i}.${f.slice(0, 2)}`, '.');
  }
  return null;
}

const CURRENCIES: Currency[] = ['BRL', 'USD', 'EUR'];

/** Lê todas as contas/cartões do OFX. Um arquivo pode ter mais de um extrato. */
export function parseOfxStatements(text: string): ParsedStatement[] {
  if (!text.trim()) throw new StatementError('Arquivo vazio.');
  if (!looksLikeOfx(text)) throw new StatementError('O arquivo não parece ser OFX.');
  const ofx = parseOfxTree(text);
  const fi = findAll(ofx, 'FI')[0];
  const institutionName = cleanText(val(fi, 'ORG'), 80) || undefined;
  const stmts = [...findAll(ofx, 'STMTRS').map((n) => ({ n, kind: 'bank' as const })), ...findAll(ofx, 'CCSTMTRS').map((n) => ({ n, kind: 'card' as const }))];
  if (!stmts.length) throw new StatementError('Nenhum extrato bancário (STMTRS) ou de cartão (CCSTMTRS) no OFX. Outros tipos (investimentos, faturas eletrônicas) não são suportados.');
  let total = 0;
  return stmts.map(({ n, kind }) => {
    const acct = child(n, kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM');
    const curRaw = (val(n, 'CURDEF') ?? 'BRL').toUpperCase();
    const warnings: string[] = [];
    let currency: Currency = 'BRL';
    if (CURRENCIES.includes(curRaw as Currency)) currency = curRaw as Currency;
    else throw new StatementError(`Moeda ${cleanText(curRaw, 10)} não suportada (BRL, USD, EUR).`);
    const list = child(n, 'BANKTRANLIST');
    const trns = list ? list.children.filter((c) => c.tag === 'STMTTRN') : [];
    total += trns.length;
    if (total > OFX_LIMITS.maxTransactions) throw new StatementError(`Mais de ${OFX_LIMITS.maxTransactions} movimentações: divida o arquivo.`);
    const drafts: TransactionDraft[] = [];
    const invalid: InvalidRow[] = [];
    trns.forEach((t, i) => {
      const line = i + 1;
      const date = parseBankDate(val(t, 'DTPOSTED') ?? '');
      if (!date) { invalid.push({ line, reason: `Movimentação ${line}: data inválida.` }); return; }
      const cents = ofxAmount(val(t, 'TRNAMT'));
      if (cents === null) { invalid.push({ line, reason: `Movimentação ${line}: valor inválido “${cleanText(val(t, 'TRNAMT'), 30)}”.` }); return; }
      if (cents === 0) return;
      const name = cleanText(val(t, 'NAME'));
      const memo = cleanText(val(t, 'MEMO'));
      const description = name || memo;
      if (!description) { invalid.push({ line, reason: `Movimentação ${line}: sem descrição.` }); return; }
      const op = val(t, 'DTUSER') ? parseBankDate(val(t, 'DTUSER')!) : null;
      const fitid = cleanText(val(t, 'FITID'), 120);
      const curT = child(t, 'CURRENCY') ?? child(t, 'ORIGCURRENCY');
      if (curT) warnings.push(`Movimentação ${line} em moeda estrangeira: valor mantido como informado em ${currency}.`);
      drafts.push({
        line,
        externalId: fitid || undefined,
        postedDate: date,
        operationDate: op && op !== date ? op : undefined,
        description,
        memo: name && memo && memo !== name ? memo : undefined,
        amountCents: cents,
        currency,
        rawType: cleanText(val(t, 'TRNTYPE'), 20).toUpperCase() || undefined,
        status: 'posted',
        reference: cleanText(val(t, 'CHECKNUM') ?? val(t, 'REFNUM'), 60) || undefined,
      });
    });
    const ledger = child(n, 'LEDGERBAL');
    const avail = child(n, 'AVAILBAL');
    const balCents = ofxAmount(val(ledger, 'BALAMT'));
    const balDate = parseBankDate(val(ledger, 'DTASOF') ?? '');
    const availCents = ofxAmount(val(avail, 'BALAMT'));
    const fromDate = parseBankDate(val(list, 'DTSTART') ?? '');
    const toDate = parseBankDate(val(list, 'DTEND') ?? '');
    const r = rangeOf(drafts);
    return {
      format: 'ofx' as const,
      drafts,
      invalid,
      ignored: [],
      warnings: [...new Set(warnings)],
      account: {
        kind,
        institutionCode: cleanText(val(acct, 'BANKID') ?? val(fi, 'FID'), 20) || undefined,
        institutionName,
        maskedNumber: maskIdentifier(val(acct, 'ACCTID')),
        acctType: cleanText(val(acct, 'ACCTTYPE'), 20) || undefined,
        currency,
      },
      reportedBalance: balCents !== null && balDate ? { cents: balCents, asOf: balDate, availableCents: availCents ?? undefined } : undefined,
      range: fromDate && toDate ? { from: fromDate, to: toDate } : r,
    };
  });
}

/** Decodifica os bytes de um extrato: UTF-8 estrito, senão Windows-1252 (comum em bancos brasileiros). */
export function decodeStatementBytes(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 600)).toUpperCase();
  const declares1252 = /CHARSET:\s*(1252|ISO-8859-1|8859-1)/.test(head) || /ENCODING="?(WINDOWS-1252|ISO-8859-1)/.test(head);
  if (!declares1252) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* não é UTF-8 */ }
  }
  return new TextDecoder('windows-1252').decode(bytes);
}
