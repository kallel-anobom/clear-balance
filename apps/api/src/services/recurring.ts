import { z } from 'zod';
import type { Queryable } from '../db.js';
import { MONTH_RE, clampedDate, monthOf, todayISO } from '../lib.js';

const cents = z.number().int();
const optId = z.number().int().positive().nullable().optional();

export const recurringSchema = z.object({
  description: z.string().trim().min(1).max(200),
  type: z.enum(['expense', 'income']),
  category_id: optId,
  account_id: optId,
  frequency: z.enum(['monthly', 'yearly']).default('monthly'),
  day_of_month: z.number().int().min(1).max(31).nullable().optional(),
  month_of_year: z.number().int().min(1).max(12).nullable().optional(),
  start_month: z.string().regex(MONTH_RE).nullable().optional(),
  end_month: z.string().regex(MONTH_RE).nullable().optional(),
  total_cents: cents,
  my_share_cents: cents.nullable().optional(),
  gross_cents: cents.nullable().optional(),
  deductions_cents: cents.nullable().optional(),
  shared_with: z.string().trim().max(200).nullable().optional(),
  is_estimate: z.boolean().optional(),
  needs_review: z.boolean().optional(),
  review_note: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
  active: z.boolean().optional(),
});
export type RecurringInput = z.infer<typeof recurringSchema>;

/**
 * Cria, para o mês, os lançamentos "agendados" das recorrências ativas que ainda não existem.
 * Idempotente: não duplica e respeita lançamentos apagados de propósito (recurring_skips).
 * Recorrências sem dia definido geram lançamento sem data (marcado como "data a confirmar").
 * Anuais sem mês definido não geram nada.
 */
export async function ensureMonth(db: Queryable, month: string): Promise<number> {
  const [year, mon] = month.split('-').map(Number);
  const { rows: items } = await db.query(
    `select * from recurring_items r
     where r.active
       and (r.start_month is null or r.start_month <= $1)
       and (r.end_month is null or r.end_month >= $1)
       and (r.frequency = 'monthly' or r.month_of_year = $2)
       and not exists (select 1 from recurring_skips s where s.recurring_id = r.id and s.month_ref = $1)
       and not exists (select 1 from transactions t where t.recurring_id = r.id and t.month_ref = $1)`,
    [month, mon],
  );
  for (const r of items) {
    const due = r.day_of_month ? clampedDate(year, mon, r.day_of_month) : null;
    const isIncome = r.type === 'income';
    await db.query(
      `insert into transactions
        (type, description, category_id, account_id, status, month_ref, due_date, date_confirmed,
         total_cents, my_share_cents, gross_cents, deductions_cents, shared_with,
         is_estimate, needs_review, review_note, notes, recurring_id)
       values ($1,$2,$3,$4,'scheduled',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       on conflict do nothing`,
      [
        r.type, r.description, r.category_id, r.account_id, month, due, due !== null,
        r.total_cents, isIncome ? null : (r.my_share_cents ?? r.total_cents),
        r.gross_cents, r.deductions_cents, r.shared_with,
        r.is_estimate, r.needs_review, r.review_note, r.notes, r.id,
      ],
    );
  }
  return items.length;
}

export function normalizeRecurring(input: RecurringInput) {
  const r = { ...input };
  if (r.type === 'income') {
    if (r.gross_cents != null) r.total_cents = r.gross_cents - (r.deductions_cents ?? 0);
    r.my_share_cents = null;
  } else {
    r.gross_cents = null;
    r.deductions_cents = null;
    if (r.my_share_cents == null) r.my_share_cents = r.total_cents;
  }
  if (r.frequency === 'monthly') r.month_of_year = null;
  return r;
}

export interface PropagationResult {
  /** Lançamentos futuros atualizados com os novos dados da recorrência. */
  updated: number;
  /** Lançamentos futuros que deixaram de valer (recorrência pausada, fora do período ou mês anual mudou). */
  removed: number;
}

/**
 * Aplica a recorrência (já salva) aos lançamentos JÁ GERADOS dos meses atual e futuros.
 * Só mexe em lançamentos previstos (não pagos) e que você não editou à mão; pagos e editados ficam como estão.
 * Com dryRun, apenas conta o que seria alterado.
 */
export async function propagateRecurring(
  db: Queryable,
  recurringId: number,
  opts: { dryRun?: boolean; fromMonth?: string } = {},
): Promise<PropagationResult> {
  const fromMonth = opts.fromMonth ?? monthOf(todayISO());
  const { rows: recs } = await db.query('select * from recurring_items where id = $1', [recurringId]);
  const r = recs[0];
  if (!r) return { updated: 0, removed: 0 };
  const { rows: targets } = await db.query(
    `select id, month_ref from transactions
     where recurring_id = $1 and status = 'scheduled' and not manually_edited and month_ref >= $2
     order by month_ref`,
    [recurringId, fromMonth],
  );

  const stillValid = (month: string) =>
    r.active &&
    (!r.start_month || r.start_month <= month) &&
    (!r.end_month || r.end_month >= month) &&
    (r.frequency === 'monthly' || r.month_of_year === Number(month.slice(5, 7)));

  const keep = targets.filter((t) => stillValid(t.month_ref));
  const drop = targets.filter((t) => !stillValid(t.month_ref));
  if (opts.dryRun) return { updated: keep.length, removed: drop.length };

  const isIncome = r.type === 'income';
  for (const t of keep) {
    const [y, m] = t.month_ref.split('-').map(Number);
    const due = r.day_of_month ? clampedDate(y, m, r.day_of_month) : null;
    await db.query(
      `update transactions set
         description = $2, category_id = $3, account_id = $4, due_date = $5, date_confirmed = $6,
         total_cents = $7, my_share_cents = $8, gross_cents = $9, deductions_cents = $10, shared_with = $11,
         is_estimate = $12, needs_review = $13, review_note = $14, notes = $15, updated_at = now()
       where id = $1`,
      [
        t.id, r.description, r.category_id, r.account_id, due, due !== null,
        r.total_cents, isIncome ? null : (r.my_share_cents ?? r.total_cents), r.gross_cents, r.deductions_cents, r.shared_with,
        r.is_estimate, r.needs_review, r.review_note, r.notes,
      ],
    );
  }
  if (drop.length) await db.query('delete from transactions where id = any($1::bigint[])', [drop.map((t) => t.id)]);
  return { updated: keep.length, removed: drop.length };
}
