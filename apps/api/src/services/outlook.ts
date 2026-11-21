import { addMonths, clampedDate, diffDays, monthOf } from '../lib.js';
import type { FlowItem } from './overview.js';

/**
 * Previsão do que vai sair da conta nos próximos meses. O custo do mês (por competência) responde "quanto gastei";
 * aqui a pergunta é "quanto vou pagar", então o que conta é a fatura que VENCE no mês, inclusive compras ainda
 * não lançadas. A estimativa é só média histórica e sempre aparece separada do que já está lançado.
 */
export interface InvoiceInfo {
  /** null = fatura ainda não existe (estimada só pela média das anteriores). */
  invoice_id: number | null;
  card_id: number;
  card_name: string;
  due_date: string;
  closing_date: string | null;
  statement_total_cents: number | null;
  /** Valor parcial informado pelo usuário e a data em que ele foi informado (fatura aberta sem as compras). */
  partial_total_cents?: number | null;
  partial_on?: string | null;
  /** Parcelas e lançamentos de recorrência: valor que já se sabe que virá. */
  fixed_cents: number;
  /** Demais compras lançadas até agora. */
  variable_cents: number;
  lines_count: number;
  /** Data da compra mais recente já lançada (sem contar parcelas previstas). */
  last_purchase_on: string | null;
}

export type InvoiceBasis = 'confirmed' | 'closed' | 'estimate' | 'launched_only';

export interface InvoiceEstimate extends InvoiceInfo {
  /** O que já está lançado (ou o total confirmado da fatura). */
  committed_cents: number;
  /** Valor esperado ao fechar. Igual ao lançado quando não há como estimar. */
  estimated_cents: number;
  basis: InvoiceBasis;
  /** Quantas faturas anteriores entraram na média (0 a 3). */
  history_count: number;
  avg_variable_cents: number | null;
  stale_days: number | null;
  /** Fatura aberta cujo último lançamento é antigo: o número pode estar defasado. */
  is_stale: boolean;
}

export const HISTORY_INVOICES = 3;
export const STALE_AFTER_DAYS = 3;

/** Primeiro dia do ciclo = dia seguinte ao fechamento do mês anterior. */
function cycleStart(closing: string): string {
  const prev = addMonths(monthOf(closing), -1);
  const day = clampedDate(Number(prev.slice(0, 4)), Number(prev.slice(5, 7)), Number(closing.slice(8, 10)));
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * `history` = parte variável (sem parcelas) das últimas faturas já fechadas do mesmo cartão, da mais recente
 * para a mais antiga. Só as primeiras 3 entram na média.
 */
export function estimateInvoice(info: InvoiceInfo, history: number[], today: string): InvoiceEstimate {
  // O valor parcial informado vale como "já lançado" quando é maior que as compras (fatura que não dá para importar ainda).
  const launched = Math.max(info.fixed_cents + info.variable_cents, info.partial_total_cents ?? 0);
  const variableNow = launched - info.fixed_cents;
  const used = history.filter((v) => v > 0).slice(0, HISTORY_INVOICES);
  const avg = used.length ? Math.round(used.reduce((a, b) => a + b, 0) / used.length) : null;
  const base = { ...info, history_count: used.length, avg_variable_cents: avg, stale_days: null, is_stale: false };

  if (info.statement_total_cents !== null) {
    return { ...base, committed_cents: info.statement_total_cents, estimated_cents: info.statement_total_cents, basis: 'confirmed' };
  }
  // Depois do fechamento nenhuma compra nova entra: o que está lançado é o que vale.
  if (info.closing_date !== null && info.closing_date < today) {
    return { ...base, committed_cents: launched, estimated_cents: launched, basis: 'closed' };
  }

  // Fatura aberta: frescor dos dados (só faz sentido depois que o ciclo começou).
  const started = info.closing_date === null || cycleStart(info.closing_date) <= today;
  // O frescor considera a compra mais recente e também a data em que o valor parcial foi informado.
  const lastUpdate = [info.last_purchase_on, info.partial_on ?? null].filter((d): d is string => !!d).sort().pop() ?? null;
  const staleDays = lastUpdate ? diffDays(today, lastUpdate) : null;
  const isStale = started && (staleDays === null || staleDays > STALE_AFTER_DAYS);
  const fresh = { ...base, stale_days: staleDays, is_stale: isStale };

  if (avg === null) return { ...fresh, committed_cents: launched, estimated_cents: launched, basis: 'launched_only' };
  return { ...fresh, committed_cents: launched, estimated_cents: info.fixed_cents + Math.max(variableNow, avg), basis: 'estimate' };
}

export interface OutlookMonth {
  month: string;
  is_current: boolean;
  /** Já saiu da conta neste mês (só faz sentido no mês atual). */
  paid_cents: number;
  /** Contas, recorrências e outras saídas pendentes (sem faturas). */
  other_cents: number;
  other_items: { key: string; label: string; date: string | null; amount_cents: number; estimated: boolean }[];
  invoices: InvoiceEstimate[];
  /** Certo: contas pendentes + o que já está lançado nas faturas. */
  committed_cents: number;
  /** Esperado: contas pendentes + faturas estimadas ao fechar. */
  estimated_cents: number;
  has_estimates: boolean;
  stale_count: number;
}

/**
 * Junta o fluxo de caixa do mês (`cash.items` da visão do mês) com as faturas estimadas.
 * As faturas do fluxo (pendentes, sem lançamento de pagamento) são substituídas pelas estimativas.
 */
export function buildOutlookMonth(input: {
  month: string; today: string; paid_cents: number; cash_items: FlowItem[]; invoices: InvoiceEstimate[];
}): OutlookMonth {
  const others = input.cash_items.filter((i) => i.status === 'pending' && !(i.kind === 'fatura' && i.tx_id === null && i.invoice_id !== null));
  const otherCents = others.reduce((s, i) => s + i.amount_cents, 0);
  const invoices = [...input.invoices].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.card_name.localeCompare(b.card_name));
  return {
    month: input.month,
    is_current: monthOf(input.today) === input.month,
    paid_cents: input.paid_cents,
    other_cents: otherCents,
    other_items: others.map((i) => ({ key: i.key, label: i.label, date: i.date, amount_cents: i.amount_cents, estimated: i.estimated })),
    invoices,
    committed_cents: otherCents + invoices.reduce((s, i) => s + i.committed_cents, 0),
    estimated_cents: otherCents + invoices.reduce((s, i) => s + i.estimated_cents, 0),
    has_estimates: others.some((i) => i.estimated) || invoices.some((i) => i.basis === 'estimate' || i.basis === 'launched_only'),
    stale_count: invoices.filter((i) => i.is_stale).length,
  };
}
