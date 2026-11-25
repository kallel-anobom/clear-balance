import type { FastifyInstance } from 'fastify';
import { pool } from '../db.js';
import { baseDescription } from '../services/installments.js';

/** Compras parceladas em andamento e quanto ainda vai cair em cada mês (parcelas projetadas). */
export async function installmentRoutes(app: FastifyInstance) {
  // `include_done=1` traz também as compras já quitadas (todas as parcelas reais), para a tela "Parcelas".
  app.get<{ Querystring: { card_id?: string; include_done?: string } }>('/installments', async (req) => {
    const cardId = req.query.card_id ? Number(req.query.card_id) : null;
    const includeDone = req.query.include_done === '1';
    const groups = await pool.query(
      `select t.installment_group as "group", t.card_id, cd.name as card_name,
         max(t.installment_total)::int as total,
         max(case when not t.is_projected then t.installment_no end)::int as last_real_no,
         (count(*) filter (where t.is_projected))::int as remaining_count,
         coalesce(sum(coalesce(t.my_share_cents, t.total_cents)) filter (where t.is_projected), 0) as remaining_mine_cents,
         coalesce(sum(t.total_cents) filter (where t.is_projected), 0) as remaining_total_cents,
         coalesce(sum(coalesce(t.my_share_cents, t.total_cents)) filter (where not t.is_projected), 0) as paid_mine_cents,
         min(t.month_ref) filter (where t.is_projected) as next_month,
         max(t.month_ref) filter (where t.is_projected) as last_month,
         max(t.month_ref) as end_month,
         (array_agg(t.description order by t.is_projected, t.installment_no desc))[1] as description,
         (array_agg(coalesce(t.my_share_cents, t.total_cents) order by t.installment_no desc))[1] as installment_mine_cents
       from transactions t join cards cd on cd.id = t.card_id
       where t.installment_group is not null and t.type = 'expense' and ($1::int is null or t.card_id = $1)
       group by t.installment_group, t.card_id, cd.name
       having $2::boolean or count(*) filter (where t.is_projected) > 0
       order by min(t.month_ref) filter (where t.is_projected) nulls last, description`,
      [cardId, includeDone],
    );
    // Parcelas que ainda vão cair, por mês e por cartão (a tela "Parcelas" mostra de qual cartão vem cada valor).
    const byMonthCard = await pool.query(
      `select t.month_ref as month, t.card_id, cd.name as card_name,
         sum(coalesce(t.my_share_cents, t.total_cents)) as mine_cents, count(*)::int as count
       from transactions t join cards cd on cd.id = t.card_id
       where t.is_projected and t.type = 'expense' and ($1::int is null or t.card_id = $1)
       group by t.month_ref, t.card_id, cd.name order by t.month_ref, cd.name`,
      [cardId],
    );
    type MonthEntry = { month: string; mine_cents: number; count: number; cards: { card_id: number; card_name: string; mine_cents: number; count: number }[] };
    const months = new Map<string, MonthEntry>();
    for (const r of byMonthCard.rows) {
      const m: MonthEntry = months.get(r.month) ?? { month: r.month, mine_cents: 0, count: 0, cards: [] };
      m.mine_cents += r.mine_cents;
      m.count += r.count;
      m.cards.push({ card_id: r.card_id, card_name: r.card_name, mine_cents: r.mine_cents, count: r.count });
      months.set(r.month, m);
    }
    return {
      groups: groups.rows.map((g) => ({ ...g, description: baseDescription(g.description) })),
      by_month: [...months.values()],
      remaining_mine_cents: groups.rows.reduce((s, g) => s + g.remaining_mine_cents, 0),
    };
  });
}
