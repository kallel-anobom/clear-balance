import { parse } from 'csv-parse/sync';
import { normalizeText, parseDate, parseMoney } from '../lib.js';
import type { ParsedRow, TargetKind } from './types.js';

export interface CsvMapping {
  date: number;
  description: number;
  amount?: number;
  credit?: number;
  debit?: number;
}

export interface CsvParseResult {
  delimiter: string;
  headers: string[];
  sample: string[][];
  mapping: Partial<CsvMapping>;
  needs_mapping: boolean;
  rows: ParsedRow[];
  skipped: number;
}

/** Arquivos de bancos brasileiros costumam estar em UTF-8, mas alguns vêm em Windows-1252/Latin-1. */
export function decodeText(buf: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 15);
  const counts = [';', '\t', ','].map((d) => ({ d, n: lines.reduce((s, l) => s + (l.split(d).length - 1), 0) }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0].n > 0 ? counts[0].d : ',';
}

const HEADER_HINTS = {
  date: /^(data|date|dt)\b|data (da |do )?(compra|lancamento|transacao|movimentacao|operacao)/,
  description: /descri|historico|lancamento$|estabelecimento|title|titulo|memo|detalhe|favorecido/,
  amount: /^(valor|amount|quantia|montante)/,
  credit: /credito|entrada/,
  debit: /debito|saida/,
};

export function detectMapping(headers: string[]): Partial<CsvMapping> {
  const h = headers.map(normalizeText);
  const find = (re: RegExp, skip: number[] = []) => {
    const i = h.findIndex((x, idx) => !skip.includes(idx) && re.test(x));
    return i >= 0 ? i : undefined;
  };
  const date = find(HEADER_HINTS.date);
  const credit = find(HEADER_HINTS.credit);
  const debit = find(HEADER_HINTS.debit);
  const amount = find(HEADER_HINTS.amount);
  const description = find(HEADER_HINTS.description, [date ?? -1]);
  const m: Partial<CsvMapping> = {};
  if (date !== undefined) m.date = date;
  if (description !== undefined) m.description = description;
  if (amount !== undefined) m.amount = amount;
  else if (credit !== undefined || debit !== undefined) {
    if (credit !== undefined) m.credit = credit;
    if (debit !== undefined) m.debit = debit;
  }
  return m;
}

const isComplete = (m: Partial<CsvMapping>): m is CsvMapping =>
  m.date !== undefined && m.description !== undefined && (m.amount !== undefined || m.credit !== undefined || m.debit !== undefined);

function looksLikeHeader(row: string[]): boolean {
  const m = detectMapping(row);
  return m.date !== undefined && (m.amount !== undefined || m.credit !== undefined || m.debit !== undefined);
}

/** Sem cabeçalho: descobre colunas pelo conteúdo (data, valor e o texto mais longo). */
function guessByContent(rows: string[][]): Partial<CsvMapping> {
  const sample = rows.slice(0, 20);
  const cols = Math.max(...sample.map((r) => r.length));
  let date: number | undefined, amount: number | undefined, description: number | undefined;
  let bestLen = 0;
  for (let c = 0; c < cols; c++) {
    const cells = sample.map((r) => (r[c] ?? '').trim()).filter(Boolean);
    if (!cells.length) continue;
    const ratio = (f: (s: string) => unknown) => cells.filter((s) => f(s) !== null).length / cells.length;
    if (date === undefined && ratio((s) => parseDate(s, 2000)) > 0.8) date = c;
    else if (amount === undefined && ratio(parseMoney) > 0.8) amount = c;
    else {
      const avg = cells.reduce((s, x) => s + x.length, 0) / cells.length;
      if (avg > bestLen && ratio(parseMoney) < 0.5) { bestLen = avg; description = c; }
    }
  }
  const m: Partial<CsvMapping> = {};
  if (date !== undefined) m.date = date;
  if (amount !== undefined) m.amount = amount;
  if (description !== undefined) m.description = description;
  return m;
}

export interface CsvOptions {
  kind: TargetKind;
  mapping?: Partial<CsvMapping>;
  /** Inverte o sinal dos valores (bancos que exportam compras como negativo, por exemplo). */
  invertSign?: boolean;
}

export function parseCsv(buf: Buffer, opts: CsvOptions): CsvParseResult {
  const text = decodeText(buf);
  const delimiter = detectDelimiter(text);
  const all: string[][] = parse(text, {
    delimiter,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    trim: true,
  });

  // Cabeçalho: primeira linha que "parece" cabeçalho (permite linhas de resumo antes dele).
  const headerIdx = all.slice(0, 15).findIndex(looksLikeHeader);
  const headers = headerIdx >= 0 ? all[headerIdx] : (all[0] ?? []);
  const body = headerIdx >= 0 ? all.slice(headerIdx + 1) : all;
  const detected = headerIdx >= 0 ? detectMapping(headers) : guessByContent(body);
  const mapping = { ...detected, ...opts.mapping };
  const sample = all.slice(0, 6);

  if (!isComplete(mapping)) {
    return { delimiter, headers, sample, mapping, needs_mapping: true, rows: [], skipped: 0 };
  }

  const rows: ParsedRow[] = [];
  let skipped = 0;
  for (const r of body) {
    const date = parseDate(r[mapping.date] ?? '');
    const description = (r[mapping.description] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
    let signed: number | null = null;
    if (mapping.amount !== undefined) signed = parseMoney(r[mapping.amount] ?? '');
    else {
      const credit = parseMoney(r[mapping.credit ?? -1] ?? '') ?? 0;
      const debit = parseMoney(r[mapping.debit ?? -1] ?? '') ?? 0;
      if (credit !== 0 || debit !== 0) signed = Math.abs(credit) - Math.abs(debit);
    }
    // Linhas de saldo, totais e rodapés (sem data ou sem valor) são ignoradas e apenas contadas.
    if (date === null || signed === null || signed === 0 || !description) { skipped++; continue; }
    if (opts.invertSign) signed = -signed;
    // Conta: positivo = entrada. Cartão: positivo = compra (saída), negativo = crédito/estorno/pagamento.
    const positiveMeansOut = opts.kind === 'card' && mapping.amount !== undefined;
    const direction: 'in' | 'out' = signed > 0 ? (positiveMeansOut ? 'out' : 'in') : positiveMeansOut ? 'in' : 'out';
    rows.push({ date, description, abs_cents: Math.abs(signed), direction, uncertain_reason: null });
  }
  return { delimiter, headers, sample, mapping, needs_mapping: false, rows, skipped };
}
