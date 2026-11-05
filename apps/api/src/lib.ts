// Utilitários puros: dinheiro (centavos), datas (YYYY-MM-DD) e texto.

export const MONTH_RE = /^\d{4}-\d{2}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const pad = (n: number) => String(n).padStart(2, '0');

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Monta uma data limitando o dia ao último dia do mês (ex.: dia 31 em fevereiro → 28/29). */
export function clampedDate(year: number, month: number, day: number): string {
  return `${year}-${pad(month)}-${pad(Math.min(day, daysInMonth(year, month)))}`;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function addMonths(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const total = y * 12 + (m - 1) + delta;
  return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
}

export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number);
  return { start: `${month}-01`, end: `${month}-${pad(daysInMonth(y, m))}` };
}

export function isValidDate(date: string): boolean {
  if (!DATE_RE.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  return m >= 1 && m <= 12 && d >= 1 && d <= daysInMonth(y, m);
}

export function todayISO(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function diffDays(a: string, b: string): number {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  return Math.round((ta - tb) / 86_400_000);
}

const MONTH_ABBR: Record<string, number> = {
  jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12,
};

/**
 * Lê datas em formatos brasileiros: dd/mm/aaaa, dd/mm/aa, aaaa-mm-dd, dd-mm-aaaa, "05 NOV" e "dd/mm"
 * (os dois últimos precisam de refYear). Retorna null quando não for possível interpretar com segurança.
 */
export function parseDate(raw: string, refYear?: number): string | null {
  const s = raw.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  let y: number | undefined, mo: number, d: number;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[t\s].*)?$/))) {
    y = +m[1]; mo = +m[2]; d = +m[3];
  } else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/))) {
    d = +m[1]; mo = +m[2]; y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
  } else if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})$/))) {
    d = +m[1]; mo = +m[2]; y = refYear;
  } else if ((m = s.match(/^(\d{1,2})\s+(?:de\s+)?([a-zç]{3})[a-z]*\.?(?:\s+(?:de\s+)?(\d{4}))?$/))) {
    d = +m[1]; mo = MONTH_ABBR[m[2]] ?? 0; y = m[3] ? +m[3] : refYear;
  } else return null;
  if (y === undefined || !mo || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return `${y}-${pad(mo)}-${pad(d)}`;
}

/**
 * Lê valores em formato brasileiro ou internacional e devolve centavos (com sinal).
 * Aceita "R$ 1.234,56", "-1.234,56", "(1.234,56)", "1234.56", "1.234,56 D" (débito) e "1.234,56 C" (crédito).
 * Retorna null se não for um valor monetário inequívoco.
 */
export function parseMoney(raw: string): number | null {
  let s = raw.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1).trim(); }
  const suffix = s.match(/\s?([CD])$/i);
  if (suffix) { if (suffix[1].toUpperCase() === 'D') negative = true; s = s.slice(0, -suffix[0].length).trim(); }
  s = s.replace(/^R\$\s?/i, '');
  if (s.startsWith('-')) { negative = !negative; s = s.slice(1).trim(); }
  else if (s.startsWith('+')) s = s.slice(1).trim();
  s = s.replace(/^R\$\s?/i, '');
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1).trim(); }
  let normalized: string;
  if (/^\d{1,3}(\.\d{3})*(,\d{1,2})?$/.test(s)) normalized = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(,\d{1,2})?$/.test(s)) normalized = s.replace(',', '.');
  else if (/^\d{1,3}(,\d{3})*(\.\d{1,2})?$/.test(s) && s.includes(',')) normalized = s.replace(/,/g, '');
  else if (/^\d+(\.\d{1,2})?$/.test(s)) normalized = s;
  else return null;
  const cents = Math.round(parseFloat(normalized) * 100);
  if (!Number.isFinite(cents)) return null;
  return negative ? -cents : cents;
}

/** Normaliza texto para comparação: minúsculas, sem acentos, espaços colapsados. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}
