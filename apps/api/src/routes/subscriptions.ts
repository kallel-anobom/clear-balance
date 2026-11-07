import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { addMonths, monthOf, todayISO } from '../lib.js';
import { detectSubscriptions } from '../services/subscriptions.js';

const WINDOW_MONTHS = 12;

/** Assinaturas e cobranças recorrentes detectadas nos últimos 12 meses. */
export async function loadSubscriptions() {
  const current = monthOf(todayISO());
  const from = addMonths(current, -WINDOW_MONTHS);
  const [txs, recurring] = await Promise.all([
    pool.query(
      `select id, description, total_cents, my_share_cents, month_ref, occurred_on, paid_on, installment_group,
              recurring_id, is_projected, category_id, account_id
       from transactions where type = 'expense' and month_ref between $1 and $2`,
      [from, current],
    ),
    pool.query('select description from recurring_items where active'),
  ]);
  const items = detectSubscriptions(txs.rows, { currentMonth: current, recurringDescriptions: recurring.rows.map((r) => r.description) });
  return {
    window_months: WINDOW_MONTHS,
    total_monthly_cents: items.reduce((s, i) => s + i.typical_cents, 0),
    items,
  };
}

export async function subscriptionRoutes(app: FastifyInstance) {
  app.get('/subscriptions', loadSubscriptions);
}
