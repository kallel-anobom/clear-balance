import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { baseDescription } from '../services/installments.js';

/** Compras parceladas em andamento e quanto ainda vai cair em cada mês (parcelas projetadas). */
export async function installmentRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { card_id?: string } }>('/installments', async (req) => {
    const cardId = req.query.card_id ? Number(req.query.card_id) : null;
    const groups = await pool.query(
      `select t.installment_group as "group", t.card_id, cd.name as card_name,
         max(t.installment_total)::int as total,
         max(case when not t.is_projected then t.installment_no end)::int as last_real_no,
         (count(*) filter (where t.is_projected))::int as remaining_count,
         coalesce(sum(coalesce(t.my_share_cents, t.total_cents)) filter (where t.is_projected), 0) as remaining_mine_cents,
         coalesce(sum(t.total_cents) filter (where t.is_projected), 0) as remaining_total_cents,
         min(t.month_ref) filter (where t.is_projected) as next_month,
         max(t.month_ref) filter (where t.is_projected) as last_month,
         (array_agg(t.description order by t.is_projected, t.installment_no desc))[1] as description,
         (array_agg(coalesce(t.my_share_cents, t.total_cents) order by t.installment_no desc))[1] as installment_mine_cents
       from transactions t join cards cd on cd.id = t.card_id
       where t.installment_group is not null and t.type = 'expense' and ($1::int is null or t.card_id = $1)
       group by t.installment_group, t.card_id, cd.name
       having count(*) filter (where t.is_projected) > 0
       order by min(t.month_ref) filter (where t.is_projected), description`,
      [cardId],
    );
    const byMonth = await pool.query(
      `select month_ref as month, sum(coalesce(my_share_cents, total_cents)) as mine_cents, count(*)::int as count
       from transactions where is_projected and type = 'expense' and ($1::int is null or card_id = $1)
       group by month_ref order by month_ref`,
      [cardId],
    );
    return {
      groups: groups.rows.map((g) => ({ ...g, description: baseDescription(g.description) })),
      by_month: byMonth.rows,
      remaining_mine_cents: groups.rows.reduce((s, g) => s + g.remaining_mine_cents, 0),
    };
  });
}
