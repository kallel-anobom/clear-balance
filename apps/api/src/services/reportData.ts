import { pool } from '../db.js';
import { redact } from '../importer/redact.js';
import { addMonths, monthBounds, todayISO } from '../lib.js';
import { loadChecks } from './checksData.js';
import { loadOutlook } from './outlookData.js';
import { buildOverview } from './overviewData.js';
import { invoiceAmount } from './overview.js';

/**
 * Relatório para baixar e conferir fora do sistema (por exemplo, colar numa conversa para análise).
 * Por padrão só traz números e nomes de cartões; as descrições dos lançamentos só entram com `withLines`,
 * e mesmo assim passam por `redact` (CPF, e-mail, telefone, cartão, conta). Nunca inclui chaves ou configurações de acesso.
 */
export async function loadReport(month: string, withLines: boolean, today: string = todayISO()) {
  const from = monthBounds(addMonths(month, -1)).start;
  const to = monthBounds(addMonths(month, 2)).end;

  const [checks, outlook, overview, inv, unlinked, limit] = await Promise.all([
    loadChecks(month, today),
    loadOutlook(month, 3, today),
    buildOverview(month, today),
    pool.query(
      `select i.id, i.card_id, c.name as card_name, i.due_date, i.closing_date, i.paid_on, i.statement_total_cents,
              i.partial_total_cents, i.partial_on,
              coalesce(sum(t.total_cents) filter (where t.type = 'expense'), 0) as lines_total_cents,
              count(t.id) filter (where t.type = 'expense')::int as lines_count,
              coalesce(sum(t.total_cents) filter (where t.type = 'expense' and t.is_projected), 0) as projected_cents
       from invoices i join cards c on c.id = i.card_id
       left join transactions t on t.invoice_id = i.id
       where i.due_date between $1 and $2
       group by i.id, c.name order by i.due_date, c.name`,
      [from, to],
    ),
    pool.query(
      `select t.total_cents, t.paid_on, a.name as account_name
       from transactions t left join accounts a on a.id = t.account_id
       where t.type = 'invoice_payment' and t.invoice_id is null order by t.paid_on desc nulls last`,
    ),
    pool.query(`select value from settings where key = 'monthly_limit_cents'`),
  ]);

  const lines = new Map<number, unknown[]>();
  if (withLines && inv.rows.length) {
    const { rows } = await pool.query(
      `select invoice_id, occurred_on, description, total_cents, installment_no, installment_total, is_projected
       from transactions where type = 'expense' and invoice_id = any($1::int[]) order by occurred_on, id`,
      [inv.rows.map((r) => r.id)],
    );
    for (const r of rows) {
      const list = lines.get(r.invoice_id) ?? [];
      list.push({
        date: r.occurred_on,
        description: redact(r.description),
        cents: r.total_cents,
        installment: r.installment_no ? `${r.installment_no}/${r.installment_total}` : null,
        projected: r.is_projected,
      });
      lines.set(r.invoice_id, list);
    }
  }

  return {
    kind: 'clear-balance-conferencia',
    version: 1,
    generated_on: today,
    month,
    includes_lines: withLines,
    note: 'Valores em centavos. "committed" = já lançado (ou total confirmado); "estimated" = esperado ao fechar. Pagamento de fatura nunca soma como despesa.',
    monthly_limit_cents: typeof limit.rows[0]?.value === 'number' ? limit.rows[0].value : null,
    month_summary: {
      cost_mine_cents: overview.spending.total_mine_cents,
      cash_paid_cents: overview.cash.paid_cents,
      cash_pending_cents: overview.cash.pending_cents,
      income_net_cents: overview.income.net_cents,
      income_received_cents: overview.income.received_net_cents,
    },
    checks: checks.checks.map((c) => ({ code: c.code, level: c.level, title: c.title, detail: c.detail })),
    checks_passed: `${checks.passed} de ${checks.total}`,
    outlook: outlook.months.map((m) => ({
      month: m.month,
      paid_cents: m.paid_cents,
      other_cents: m.other_cents,
      committed_cents: m.committed_cents,
      estimated_cents: m.estimated_cents,
      stale_count: m.stale_count,
      other_items: withLines ? m.other_items.map((o) => ({ label: redact(o.label), date: o.date, cents: o.amount_cents, estimated: o.estimated })) : undefined,
      invoices: m.invoices.map((i) => ({
        card: i.card_name,
        due_date: i.due_date,
        closing_date: i.closing_date,
        basis: i.basis,
        committed_cents: i.committed_cents,
        estimated_cents: i.estimated_cents,
        fixed_cents: i.fixed_cents,
        variable_cents: i.variable_cents,
        lines_count: i.lines_count,
        partial_total_cents: i.partial_total_cents ?? null,
        partial_on: i.partial_on ?? null,
        statement_total_cents: i.statement_total_cents,
        history_count: i.history_count,
        avg_variable_cents: i.avg_variable_cents,
        last_purchase_on: i.last_purchase_on,
        is_stale: i.is_stale,
      })),
    })),
    invoices: inv.rows.map((r) => {
      const { cents, estimated } = invoiceAmount(r);
      return {
        card: r.card_name,
        due_date: r.due_date,
        closing_date: r.closing_date,
        paid_on: r.paid_on,
        status: r.paid_on ? 'paid' : r.closing_date && r.closing_date < today ? 'closed' : 'open',
        amount_cents: cents,
        amount_estimated: estimated,
        statement_total_cents: r.statement_total_cents,
        partial_total_cents: r.partial_total_cents,
        partial_on: r.partial_on,
        lines_total_cents: r.lines_total_cents,
        lines_count: r.lines_count,
        projected_cents: r.projected_cents,
        mismatch_cents: r.statement_total_cents !== null ? r.statement_total_cents - r.lines_total_cents : null,
        lines: withLines ? (lines.get(r.id) ?? []) : undefined,
      };
    }),
    unlinked_payments: unlinked.rows.map((p) => ({ date: p.paid_on, cents: p.total_cents, account: p.account_name })),
  };
}
