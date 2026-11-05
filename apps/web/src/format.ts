const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** Centavos → "R$ 1.234,56". */
export const brl = (cents: number | null | undefined) => (cents == null ? '—' : brlFmt.format(cents / 100));

/** "2026-11-05" → "05/11/2026". */
export const dateBR = (iso: string | null | undefined) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '—';

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const monthLabel = (ym: string) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} de ${ym.slice(0, 4)}`;
export const monthShort = (ym: string) => `${ym.slice(5, 7)}/${ym.slice(0, 4)}`;

export function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + delta;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export const todayISO = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const currentMonth = () => todayISO().slice(0, 7);

/** Texto digitado ("1.234,56", "1234,5", "R$ 10") → centavos; null se vazio/inválido. */
export function parseMoneyInput(raw: string): number | null {
  let s = raw.trim().replace(/^R\$\s?/i, '');
  if (!s) return null;
  let neg = false;
  if (s.startsWith('-')) { neg = true; s = s.slice(1).trim(); }
  if (/^\d{1,3}(\.\d{3})+(,\d{1,2})?$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d+(,\d{1,2})?$/.test(s)) s = s.replace(',', '.');
  else if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
  const v = Math.round(parseFloat(s) * 100);
  return neg ? -v : v;
}

/** Centavos → texto para o campo ("1234,56"). */
export const centsToInput = (cents: number | null | undefined) =>
  cents == null ? '' : (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: false });

export const TYPE_LABEL: Record<string, string> = {
  income: 'Receita',
  expense: 'Despesa',
  transfer: 'Transferência',
  reimbursement: 'Reembolso',
  invoice_payment: 'Pagamento de fatura',
  overdraft_payment: 'Pagamento do cheque especial',
};
