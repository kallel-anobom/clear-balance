import { pool } from '../db.js';
import { monthBounds, todayISO } from '../lib.js';
import { computeChecks, type ChecksResult, type DuplicateGroup, type InvoiceCheckRow } from './checks.js';
import { loadOutlook } from './outlookData.js';
import { buildOverview } from './overviewData.js';

/** Busca os dados de um mês e roda a conferência dos números (ver `checks.ts`). */
export async function loadChecks(month: string, today: string = todayISO()): Promise<ChecksResult> {
  const { start, end } = monthBounds(month);
  const [outlook, overview, invoices, dups, uncat] = await Promise.all([
    loadOutlook(month, 1, today),
    buildOverview(month, today),
    pool.query(
      `select i.id, i.card_id, c.name as card_name, i.due_date, i.statement_total_cents, i.paid_on,
              coalesce(sum(t.total_cents), 0) as lines_total_cents, count(t.id)::int as lines_count
       from invoices i join cards c on c.id = i.card_id
       left join transactions t on t.invoice_id = i.id and t.type = 'expense'
       where i.due_date between $1 and $2
       group by i.id, c.name order by i.due_date`,
      [start, end],
    ),
    pool.query(
      `select t.occurred_on, c.name as card_name, t.total_cents, count(*)::int as count
       from transactions t join cards c on c.id = t.card_id
       where t.type = 'expense' and not t.is_projected and t.occurred_on between $1 and $2
       group by t.occurred_on, c.name, t.total_cents, lower(t.description)
       having count(*) > 1
       order by t.occurred_on`,
      [start, end],
    ),
    pool.query(
      `select count(*)::int as count, coalesce(sum(coalesce(my_share_cents, total_cents)), 0) as total_cents
       from transactions where type = 'expense' and month_ref = $1 and category_id is null`,
      [month],
    ),
  ]);

  return computeChecks({
    month,
    today,
    outlook: outlook.months[0],
    invoices: invoices.rows as InvoiceCheckRow[],
    overview_pending_cents: overview.cash.pending_cents,
    income_cents: overview.income.net_cents,
    scheduled_income_cents: overview.income.scheduled_net_cents,
    uncategorized: uncat.rows[0],
    duplicates: dups.rows as DuplicateGroup[],
  });
}
