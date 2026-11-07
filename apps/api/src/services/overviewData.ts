import { pool } from '../db.js';
import { monthBounds, todayISO } from '../lib.js';
import { compareCosts, previousMonths, type CostComparison } from './compare.js';
import { computeOverview } from './overview.js';

/** Busca os dados do mês e calcula a visão completa. Usada pela Visão do mês e pela comparação entre meses. */
export async function buildOverview(month: string, today: string = todayISO()) {
  const { start, end } = monthBounds(month);

  const [txs, invoices, accounts, reimbursements, yearly, installments, budgets] = await Promise.all([
    pool.query(
      `select t.*, c.name as category_name, c.slug as category_slug
       from transactions t left join categories c on c.id = t.category_id
       where t.month_ref = $1 or coalesce(t.paid_on, t.due_date, t.occurred_on) between $2 and $3`,
      [month, start, end],
    ),
    pool.query(
      `select i.*, cd.name as card_name,
         coalesce((select sum(t.total_cents) from transactions t where t.invoice_id = i.id and t.type = 'expense'), 0) as lines_total_cents,
         (select count(*) from transactions t where t.invoice_id = i.id and t.type = 'expense')::int as lines_count
       from invoices i join cards cd on cd.id = i.card_id
       where i.due_date between $1 and $2`,
      [start, end],
    ),
    pool.query('select id, name, balance_cents, balance_date, overdraft_limit_cents from accounts order by name'),
    pool.query(
      `select e.id, e.description, e.month_ref, e.shared_with,
         (e.total_cents - e.my_share_cents) as others_cents,
         coalesce((select sum(r.total_cents) from transactions r
                   where r.reimbursement_for_id = e.id and r.type = 'reimbursement' and r.status = 'paid'), 0) as received_cents
       from transactions e
       where e.type = 'expense' and e.my_share_cents is not null and e.total_cents - e.my_share_cents > 0`,
    ),
    pool.query(`select description from recurring_items where active and frequency = 'yearly' and month_of_year is null`),
    // Compromissos parcelados: o que cai neste mês e o que ainda falta nos meses seguintes (parcelas projetadas).
    pool.query(
      `select
         coalesce(sum(coalesce(my_share_cents, total_cents)) filter (where month_ref = $1), 0) as in_month_cents,
         (count(*) filter (where month_ref = $1))::int as in_month_count,
         coalesce(sum(coalesce(my_share_cents, total_cents)) filter (where is_projected and month_ref > $1), 0) as remaining_cents,
         (count(*) filter (where is_projected and month_ref > $1))::int as remaining_count,
         max(month_ref) filter (where is_projected) as last_month
       from transactions where installment_group is not null and type = 'expense'`,
      [month],
    ),
    pool.query(`select b.category_id, c.name as category_name, b.limit_cents from budgets b join categories c on c.id = b.category_id`),
  ]);

  const inst = installments.rows[0];
  return {
    ...computeOverview({
      month,
      today,
      txs: txs.rows,
      invoices: invoices.rows,
      accounts: accounts.rows,
      reimbursements: reimbursements.rows,
      yearlyWithoutMonth: yearly.rows.map((r) => r.description),
      budgets: budgets.rows,
    }),
    installments: {
      in_month_cents: inst.in_month_cents, in_month_count: inst.in_month_count,
      remaining_cents: inst.remaining_cents, remaining_count: inst.remaining_count, last_month: inst.last_month,
    },
  };
}

/** Custo do mês contra a média dos até 3 meses anteriores que têm gastos. `current` evita recalcular o mês atual. */
export async function loadComparison(month: string, current?: Awaited<ReturnType<typeof buildOverview>>): Promise<CostComparison> {
  const months = previousMonths(month);
  const [cur, ...prev] = await Promise.all([current ?? buildOverview(month), ...months.map((m) => buildOverview(m))]);
  const cost = (m: string, o: typeof cur) => ({ month: m, total_mine_cents: o.spending.total_mine_cents, by_category: o.spending.by_category });
  return compareCosts(cost(month, cur), months.map((m, i) => cost(m, prev[i])));
}
