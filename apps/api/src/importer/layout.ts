import { normalizeText, parseDate, parseMoney } from '../lib.js';
import type { ParsedRow, TargetKind } from './types.js';

/**
 * Leitor para extratos em formato de "app de banco" (prints, PDFs de celular), onde:
 *  - a data aparece como TÍTULO de um grupo ("05 NOV", "Seg, 5 de novembro", "Hoje") e não em cada linha;
 *  - a descrição e o valor ficam em linhas separadas (descrição acima do valor, ou valor acima da descrição).
 *
 * Mesmas regras do leitor clássico: nada é inventado. Linha sem data, sem direção clara ou deduzida do texto
 * fica marcada para conferência, e quem chama trata o resultado como pouco confiável.
 */

export interface LayoutOptions {
  kind: TargetKind;
  /** Mês de referência AAAA-MM (usado quando a data não traz o ano). */
  refMonth: string;
  /** Data de hoje (AAAA-MM-DD), para "Hoje" e "Ontem". */
  today: string;
}

export interface LayoutResult {
  rows: ParsedRow[];
  /** Houve datas relativas ("Hoje", "Ontem") ou sem ano. */
  relativeDates: boolean;
  yearless: boolean;
  dateHeaders: number;
  mode: 'desc-first' | 'amount-first';
}

// Mesmo formato monetário do leitor clássico (vírgula decimal obrigatória).
const MONEY = /(?:R\$\s?)?[-+]?\(?\d{1,3}(?:\.\d{3})*,\d{2}\)?-?(?:\s?[CD])?(?=\s|$)/g;

const WEEKDAY = '(?:segunda|terca|quarta|quinta|sexta|sabado|domingo|seg|ter|qua|qui|sex|sab|dom)(?:-feira)?';
const WEEKDAY_PREFIX = new RegExp(`^${WEEKDAY}\\.?,?\\s*-?\\s*`);
const WEEKDAY_SUFFIX = new RegExp(`\\s*[,-]?\\s*${WEEKDAY}$`);

const SKIP_ROW = /^(saldo|sdo|total)\b|saldo (do dia|anterior|final|parcial|disponivel)/;
const TIME_ONLY = /^\d{1,2}[:h]\d{2}(\s?h)?$/;
const SUBLABEL = /^(compra (no )?(debito|credito)|debito|credito|aprovad[ao]|finalizad[ao]|concluid[ao]|processando|em processamento)$/;

const IN_HINT = /\b(recebid[oa]|recebimento|reembolso|estorno|deposito|salario|rendimento)\b/;
const OUT_HINT = /\b(enviad[oa]|pagamento|compra|debito|saque|tarifa|boleto)\b/;

function normLine(line: string): string {
  return line
    .replace(/[−–—]/g, '-')
    // "- R$ 12,30" -> "R$ -12,30"
    .replace(/([-+])\s*R\$\s*(?=\d)/g, 'R$ $1')
    .replace(/\s+/g, ' ')
    .trim();
}

const letters = (s: string) => (s.match(/\p{L}/gu) ?? []).length;

function shiftDay(iso: string, delta: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

interface Header {
  iso: string | null;
  relative: boolean;
  yearless: boolean;
}

function dateHeader(line: string, refYear: number, refMon: number, today: string): Header | null {
  if (line.length > 48 || line.match(MONEY)) return null;
  let s = normalizeText(line).replace(/[·•|]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(WEEKDAY_PREFIX, '').replace(WEEKDAY_SUFFIX, '').trim();
  if (s === 'hoje') return { iso: today, relative: true, yearless: false };
  if (s === 'ontem') return { iso: shiftDay(today, -1), relative: true, yearless: false };
  if (s === 'anteontem') return { iso: shiftDay(today, -2), relative: true, yearless: false };
  const hasYear = /(^|\D)\d{4}$/.test(s) || /^\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(s);
  let iso = parseDate(s, refYear);
  if (!iso) return null;
  if (!hasYear && Number(iso.slice(5, 7)) > refMon) iso = parseDate(s, refYear - 1);
  return iso ? { iso, relative: false, yearless: !hasYear } : null;
}

type Item =
  | { k: 'H'; header: Header }
  | { k: 'T'; text: string }
  | { k: 'M'; line: string }
  | { k: 'L'; line: string; text: string };

function classify(raw: string, refYear: number, refMon: number, today: string): Item | null {
  const line = normLine(raw);
  if (!line || TIME_ONLY.test(line) || /^R\$$/.test(line)) return null;
  const header = dateHeader(line, refYear, refMon, today);
  if (header) return { k: 'H', header };
  const tokens = line.match(MONEY);
  const text = line.replace(MONEY, ' ').replace(/R\$/g, ' ').replace(/\s+/g, ' ').replace(/^[\s\-–·•|:]+|[\s\-–·•|:]+$/g, '');
  if (!tokens) {
    const n = normalizeText(text);
    if (letters(text) < 2 || SUBLABEL.test(n)) return null;
    return { k: 'T', text };
  }
  return letters(text) >= 2 ? { k: 'L', line, text } : { k: 'M', line };
}

function directionFor(
  token: string,
  signed: number,
  kind: TargetKind,
  description: string,
): { direction: 'in' | 'out' | null; reason: string | null } {
  const t = token.trim();
  const suffix = t.match(/\s?([CD])$/i)?.[1]?.toUpperCase();
  const plus = /^(?:R\$\s?)?\+/.test(t);
  if (kind === 'card') {
    // Em fatura, valor sem sinal é compra; sinal negativo ou crédito é estorno/pagamento.
    return { direction: suffix === 'C' || (suffix !== 'D' && signed < 0) ? 'in' : 'out', reason: null };
  }
  if (suffix === 'D' || signed < 0) return { direction: 'out', reason: null };
  if (suffix === 'C' || plus) return { direction: 'in', reason: null };
  const n = normalizeText(description);
  const inHint = IN_HINT.test(n);
  const outHint = OUT_HINT.test(n);
  if (inHint !== outHint) {
    return { direction: inHint ? 'in' : 'out', reason: 'entrada/saída deduzida pelo texto da descrição: confira' };
  }
  return { direction: null, reason: 'o documento não indica se é entrada ou saída' };
}

export function parseLayoutLines(lines: string[], opts: LayoutOptions): LayoutResult {
  const [refYear, refMon] = opts.refMonth.split('-').map(Number);
  const items: Item[] = [];
  for (const raw of lines) {
    const it = classify(raw, refYear, refMon, opts.today);
    if (it) items.push(it);
  }

  // Decide se a descrição vem antes do valor ou depois, pelo padrão que mais se repete.
  let tm = 0;
  let mt = 0;
  let prev: 'T' | 'M' | null = null;
  for (const it of items) {
    if (it.k === 'T' || it.k === 'M') {
      if (prev === 'T' && it.k === 'M') tm++;
      else if (prev === 'M' && it.k === 'T') mt++;
      prev = it.k;
    } else prev = null;
  }
  const mode: LayoutResult['mode'] = tm >= mt ? 'desc-first' : 'amount-first';

  const rows: ParsedRow[] = [];
  let date: string | null = null;
  let relativeDates = false;
  let yearless = false;
  let dateHeaders = 0;

  const emit = (descParts: string[], moneyLine: string, headerDate: string | null) => {
    const tokens = [...moneyLine.matchAll(MONEY)];
    if (!tokens.length) return;
    const first = tokens[0];
    const signed = parseMoney(first[0]);
    if (signed === null || signed === 0) return;
    const description = descParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (description.length < 2 || SKIP_ROW.test(normalizeText(description))) return;
    const reasons: string[] = [];
    if (tokens.length > 1) reasons.push('mais de um valor na linha (valor e saldo?)');
    if (!headerDate) reasons.push('sem data: informe a data');
    const dir = directionFor(first[0], signed, opts.kind, description);
    if (dir.reason) reasons.push(dir.reason);
    rows.push({
      date: headerDate,
      description,
      abs_cents: Math.abs(signed),
      direction: dir.direction,
      uncertain_reason: reasons.length ? reasons.join('; ') : null,
    });
  };

  // desc-first: [T...] M   |   amount-first: M [T...]
  let pending: string[] = [];
  let swallow = false;
  let cur: { line: string; parts: string[]; date: string | null } | null = null;
  const finishCur = () => {
    if (cur && cur.parts.length) emit(cur.parts, cur.line, cur.date);
    cur = null;
  };

  for (const it of items) {
    if (it.k === 'H') {
      finishCur();
      pending = [];
      swallow = false;
      date = it.header.iso;
      dateHeaders++;
      if (it.header.relative) relativeDates = true;
      if (it.header.yearless) yearless = true;
      continue;
    }
    if (it.k === 'L') {
      finishCur();
      const parts = [...(mode === 'desc-first' ? pending : []), it.text];
      pending = [];
      swallow = false;
      emit(parts, it.line, date);
      continue;
    }
    if (mode === 'desc-first') {
      if (it.k === 'T') {
        if (SKIP_ROW.test(normalizeText(it.text))) {
          pending = [];
          swallow = true;
        } else {
          pending.push(it.text);
          if (pending.length > 2) pending.shift();
        }
      } else {
        if (swallow) swallow = false;
        else if (pending.length) emit(pending, it.line, date);
        pending = [];
      }
    } else if (it.k === 'M') {
      finishCur();
      cur = { line: it.line, parts: [], date };
    } else if (cur) {
      const c = cur as { line: string; parts: string[]; date: string | null };
      if (SKIP_ROW.test(normalizeText(it.text))) cur = null;
      else if (c.parts.length < 2) c.parts.push(it.text);
    }
  }
  finishCur();

  return { rows, relativeDates, yearless, dateHeaders, mode };
}
