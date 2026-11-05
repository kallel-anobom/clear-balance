import { monthOf } from '../lib.js';

/**
 * Regras da "Visão do mês" (função pura, sem acesso ao banco):
 *
 * GASTO (competência)  = despesas (type=expense) do mês de referência, pelo valor da MINHA PARTE.
 *                        Compras no cartão contam aqui, na data da compra.
 * SAÍDA DE CAIXA      = despesas pagas direto da conta + pagamentos de fatura + pagamentos de cheque especial,
 *                        pelo VALOR TOTAL que sai da conta, na data do pagamento/vencimento.
 *                        Compras no cartão NÃO são saída de caixa (a saída é o pagamento da fatura).
 * Transferências próprias não entram em gasto, receita nem saída. Reembolsos não são receita.
 */

export interface TxRow {
  id: number;
  type: 'income' | 'expense' | 'transfer' | 'reimbursement' | 'invoice_payment' | 'overdraft_payment';
  description: string;
  category_id: number | null;
  category_name: string | null;
  category_slug: string | null;
  account_id: number | null;
  card_id: number | null;
  invoice_id: number | null;
  status: 'paid' | 'scheduled';
  month_ref: string;
  occurred_on: string | null;
  due_date: string | null;
  paid_on: string | null;
  date_confirmed: boolean;
  total_cents: number;
  my_share_cents: number | null;
  gross_cents: number | null;
  deductions_cents: number | null;
  is_estimate: boolean;
  needs_review: boolean;
  review_note: string | null;
}

export interface InvoiceRow {
  id: number;
  card_id: number;
  card_name: string;
  due_date: string;
  closing_date: string | null;
  statement_total_cents: number | null;
  paid_on: string | null;
  lines_total_cents: number;
  lines_count: number;
}

export interface AccountRow {
  id: number;
  name: string;
  balance_cents: number | null;
  balance_date: string | null;
  overdraft_limit_cents: number | null;
}

export interface ReimbursementItem {
  id: number;
  description: string;
  month_ref: string;
  shared_with: string | null;
  others_cents: number;
  received_cents: number;
}

export interface OverviewInput {
  month: string;
  today: string;
  /** Transações com month_ref = mês OU data de caixa dentro do mês. */
  txs: TxRow[];
  /** Faturas com vencimento no mês ou pagas no mês. */
  invoices: InvoiceRow[];
  accounts: AccountRow[];
  /** Todas as despesas compartilhadas com valor de outras pessoas (qualquer mês). */
  reimbursements: ReimbursementItem[];
  /** Descrições de despesas anuais cujo mês de pagamento ainda não foi definido. */
  yearlyWithoutMonth: string[];
}

export type FlowKind = 'conta' | 'fatura' | 'cheque_especial';

export interface FlowItem {
  key: string;
  kind: FlowKind;
  label: string;
  date: string | null;
  amount_cents: number;
  status: 'paid' | 'pending';
  estimated: boolean;
  date_confirmed: boolean;
  overdue: boolean;
  tx_id: number | null;
  invoice_id: number | null;
}

export interface Attention {
  code: string;
  text: string;
  count: number;
}

export const OVERDRAFT_COST_SLUG = 'juros-tarifas';

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const myShare = (t: TxRow) => t.my_share_cents ?? t.total_cents;

export function cashDate(t: TxRow): string | null {
  return t.paid_on ?? t.due_date ?? t.occurred_on ?? null;
}

export function cashMonth(t: TxRow): string {
  const d = cashDate(t);
  return d ? monthOf(d) : t.month_ref;
}

export function isCardPurchase(t: TxRow): boolean {
  return t.type === 'expense' && t.card_id !== null;
}

/** Valor da fatura: o total confirmado, ou a soma das compras lançadas (estimado). */
export function invoiceAmount(inv: InvoiceRow): { cents: number; estimated: boolean } {
  if (inv.statement_total_cents !== null) return { cents: inv.statement_total_cents, estimated: false };
  return { cents: inv.lines_total_cents, estimated: true };
}

export function computeOverview(input: OverviewInput) {
  const { month, today, txs, invoices, accounts, reimbursements, yearlyWithoutMonth } = input;
  const isCurrentMonth = monthOf(today) === month;

  // ---------- 1. Gastos do mês (competência, minha parte) ----------
  const expenses = txs.filter((t) => t.type === 'expense' && t.month_ref === month);
  const realized = expenses.filter((t) => t.status === 'paid');
  const planned = expenses.filter((t) => t.status === 'scheduled');
  const catMap = new Map<string, { name: string; realized_cents: number; planned_cents: number }>();
  for (const t of expenses) {
    const name = t.category_name ?? 'Sem categoria';
    const c = catMap.get(name) ?? { name, realized_cents: 0, planned_cents: 0 };
    if (t.status === 'paid') c.realized_cents += myShare(t);
    else c.planned_cents += myShare(t);
    catMap.set(name, c);
  }
  const spending = {
    realized_mine_cents: sum(realized.map(myShare)),
    realized_total_cents: sum(realized.map((t) => t.total_cents)),
    planned_mine_cents: sum(planned.map(myShare)),
    planned_total_cents: sum(planned.map((t) => t.total_cents)),
    planned_estimated_count: planned.filter((t) => t.is_estimate).length,
    by_category: [...catMap.values()].sort(
      (a, b) => b.realized_cents + b.planned_cents - (a.realized_cents + a.planned_cents),
    ),
  };

  // ---------- 2. Receitas do mês (caixa) ----------
  const incomes = txs.filter((t) => t.type === 'income' && cashMonth(t) === month);
  const income = {
    received_net_cents: sum(incomes.filter((t) => t.status === 'paid').map((t) => t.total_cents)),
    scheduled_net_cents: sum(incomes.filter((t) => t.status === 'scheduled').map((t) => t.total_cents)),
    gross_cents: sum(incomes.map((t) => t.gross_cents ?? t.total_cents)),
    deductions_cents: sum(incomes.map((t) => t.deductions_cents ?? 0)),
    net_cents: sum(incomes.map((t) => t.total_cents)),
    items: incomes.map((t) => ({
      id: t.id,
      description: t.description,
      date: cashDate(t),
      date_confirmed: t.date_confirmed && cashDate(t) !== null,
      status: t.status,
      gross_cents: t.gross_cents,
      deductions_cents: t.deductions_cents,
      net_cents: t.total_cents,
      estimated: t.is_estimate,
    })),
  };

  // ---------- 3. Saídas de caixa ----------
  const outflows: FlowItem[] = [];
  for (const t of txs) {
    if (cashMonth(t) !== month) continue;
    if (t.type === 'expense' && t.card_id === null) {
      outflows.push(flowFromTx(t, 'conta', today));
    } else if (t.type === 'invoice_payment') {
      outflows.push(flowFromTx(t, 'fatura', today));
    } else if (t.type === 'overdraft_payment') {
      outflows.push(flowFromTx(t, 'cheque_especial', today));
    }
  }
  for (const inv of invoices) {
    if (inv.paid_on !== null) continue; // pagas entram pelo lançamento de pagamento
    if (monthOf(inv.due_date) !== month) continue;
    const { cents, estimated } = invoiceAmount(inv);
    outflows.push({
      key: `inv-${inv.id}`,
      kind: 'fatura',
      label: `Fatura ${inv.card_name}`,
      date: inv.due_date,
      amount_cents: cents,
      status: 'pending',
      estimated,
      date_confirmed: true,
      overdue: inv.due_date < today,
      tx_id: null,
      invoice_id: inv.id,
    });
  }
  const byDate = (a: FlowItem, b: FlowItem) =>
    a.date === b.date ? a.label.localeCompare(b.label) : a.date === null ? 1 : b.date === null ? -1 : a.date.localeCompare(b.date);
  outflows.sort(byDate);
  const pendingOutflows = outflows.filter((o) => o.status === 'pending');
  const paidOutflows = outflows.filter((o) => o.status === 'paid');

  // ---------- 4. Reembolsos ----------
  const pendingOf = (r: ReimbursementItem) => Math.max(0, r.others_cents - r.received_cents);
  const reimbursementReceivedInMonth = sum(
    txs.filter((t) => t.type === 'reimbursement' && t.status === 'paid' && cashMonth(t) === month).map((t) => t.total_cents),
  );
  const reimbursementScheduledInMonth = sum(
    txs.filter((t) => t.type === 'reimbursement' && t.status === 'scheduled' && cashMonth(t) === month).map((t) => t.total_cents),
  );
  const pendingItems = reimbursements.filter((r) => pendingOf(r) > 0);
  const reimb = {
    pending_month_cents: sum(pendingItems.filter((r) => r.month_ref === month).map(pendingOf)),
    pending_all_cents: sum(pendingItems.map(pendingOf)),
    received_in_month_cents: reimbursementReceivedInMonth,
    items: pendingItems.map((r) => ({
      id: r.id,
      description: r.description,
      month_ref: r.month_ref,
      shared_with: r.shared_with,
      others_cents: r.others_cents,
      received_cents: r.received_cents,
      pending_cents: pendingOf(r),
    })),
  };

  // ---------- 5. Cheque especial ----------
  const overdraftAccounts = accounts
    .filter((a) => a.balance_cents !== null && a.balance_cents < 0)
    .map((a) => ({
      id: a.id,
      name: a.name,
      debt_cents: -(a.balance_cents as number),
      limit_cents: a.overdraft_limit_cents,
      balance_date: a.balance_date,
    }));
  const overdraft = {
    debt_cents: sum(overdraftAccounts.map((a) => a.debt_cents)),
    accounts: overdraftAccounts,
    // Juros e tarifas SÃO despesas; pagar a dívida (amortizar) NÃO é despesa.
    costs_in_month_cents: sum(expenses.filter((t) => t.category_slug === OVERDRAFT_COST_SLUG).map(myShare)),
    amortized_in_month_cents: sum(paidOutflows.filter((o) => o.kind === 'cheque_especial').map((o) => o.amount_cents)),
  };

  // ---------- 6. Previsão de saldo ----------
  const withBalance = accounts.filter((a) => a.balance_cents !== null);
  const currentBalance = withBalance.length ? sum(withBalance.map((a) => a.balance_cents as number)) : null;
  const pendingInflowsCents = income.scheduled_net_cents + reimbursementScheduledInMonth;
  const pendingOutflowsCents = sum(pendingOutflows.map((o) => o.amount_cents));
  const totalOutflowsCents = sum(outflows.map((o) => o.amount_cents));
  const monthResult = income.net_cents + reimbursementReceivedInMonth + reimbursementScheduledInMonth - totalOutflowsCents;
  const oldestBalanceDate = withBalance.map((a) => a.balance_date).filter(Boolean).sort()[0] ?? null;
  const forecast = {
    is_current_month: isCurrentMonth,
    current_balance_cents: currentBalance,
    accounts_without_balance: accounts.filter((a) => a.balance_cents === null).map((a) => a.name),
    balance_date: oldestBalanceDate,
    pending_inflows_cents: pendingInflowsCents,
    pending_outflows_cents: pendingOutflowsCents,
    // Saldo ao fim do mês só faz sentido no mês atual e com saldo informado por mim.
    projected_balance_cents:
      isCurrentMonth && currentBalance !== null ? currentBalance + pendingInflowsCents - pendingOutflowsCents : null,
    projected_with_reimbursements_cents:
      isCurrentMonth && currentBalance !== null
        ? currentBalance + pendingInflowsCents - pendingOutflowsCents + reimb.pending_month_cents
        : null,
    month_result_cents: monthResult,
    month_result_with_reimbursements_cents: monthResult + reimb.pending_month_cents,
    has_estimates:
      outflows.some((o) => o.estimated) || incomes.some((t) => t.is_estimate) || planned.some((t) => t.is_estimate),
    has_unconfirmed_dates:
      pendingOutflows.some((o) => !o.date_confirmed) || incomes.some((t) => !t.date_confirmed || cashDate(t) === null),
  };

  // ---------- 7. Pendências para revisão ----------
  const attention: Attention[] = [];
  const add = (code: string, text: string, count: number) => count > 0 && attention.push({ code, text, count });
  add('review', 'lançamentos marcados para revisar', txs.filter((t) => t.needs_review && t.month_ref === month).length);
  add(
    'estimated',
    'valores estimados (não confirmados)',
    outflows.filter((o) => o.estimated).length + incomes.filter((t) => t.is_estimate).length,
  );
  add(
    'dates',
    'itens com data de pagamento a confirmar',
    pendingOutflows.filter((o) => !o.date_confirmed).length + incomes.filter((t) => !t.date_confirmed || cashDate(t) === null).length,
  );
  add(
    'unlinked_payment',
    'pagamentos de fatura sem fatura vinculada (podem estar contados duas vezes)',
    txs.filter((t) => t.type === 'invoice_payment' && t.invoice_id === null && cashMonth(t) === month).length,
  );
  add(
    'card_without_invoice',
    'compras no cartão sem fatura definida',
    txs.filter((t) => isCardPurchase(t) && t.invoice_id === null && t.month_ref === month).length,
  );
  add('yearly', 'despesas anuais sem mês de pagamento definido', yearlyWithoutMonth.length);
  add('no_balance', 'contas sem saldo informado', accounts.filter((a) => a.balance_cents === null).length);

  // Próximos vencimentos: pendentes, a partir de hoje (atrasados primeiro) e depois os sem data.
  const upcoming = [...pendingOutflows].sort(byDate).slice(0, 8);

  return {
    month,
    today,
    spending,
    income,
    cash: {
      paid_cents: sum(paidOutflows.map((o) => o.amount_cents)),
      pending_cents: pendingOutflowsCents,
      total_cents: totalOutflowsCents,
      items: outflows,
    },
    upcoming,
    reimbursements: reimb,
    overdraft,
    forecast,
    attention,
    yearly_without_month: yearlyWithoutMonth,
  };
}

function flowFromTx(t: TxRow, kind: FlowKind, today: string): FlowItem {
  const date = cashDate(t);
  const pending = t.status === 'scheduled';
  return {
    key: `tx-${t.id}`,
    kind,
    label: t.description,
    date,
    amount_cents: t.total_cents,
    status: pending ? 'pending' : 'paid',
    estimated: t.is_estimate,
    date_confirmed: t.date_confirmed && date !== null,
    overdue: pending && date !== null && date < today,
    tx_id: t.id,
    invoice_id: t.invoice_id,
  };
}
