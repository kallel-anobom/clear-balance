import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { notFound } from '../errors.js';
import { MONTH_RE } from '../lib.js';
import { ensureMonth, normalizeRecurring, propagateRecurring, recurringSchema } from '../services/recurring.js';

const COLS = [
  'description', 'type', 'category_id', 'account_id', 'frequency', 'day_of_month', 'month_of_year', 'start_month',
  'end_month', 'total_cents', 'my_share_cents', 'gross_cents', 'deductions_cents', 'shared_with', 'is_estimate',
  'needs_review', 'review_note', 'notes', 'active',
] as const;

export async function recurringRoutes(app: FastifyInstance) {
  app.get('/recurring', async () => {
    const { rows } = await pool.query(
      `select r.*, c.name as category_name from recurring_items r
       left join categories c on c.id = r.category_id order by r.type desc, r.frequency, r.description`,
    );
    return rows;
  });

  app.post('/recurring', async (req, reply) => {
    const b = normalizeRecurring(recurringSchema.parse(req.body));
    const vals = COLS.map((c) => (b as Record<string, unknown>)[c] ?? (c === 'active' ? true : c === 'frequency' ? 'monthly' : null));
    const { rows } = await pool.query(
      `insert into recurring_items (${COLS.join(',')}) values (${COLS.map((_, i) => `$${i + 1}`).join(',')}) returning *`,
      vals.map((v, i) => (['is_estimate', 'needs_review'].includes(COLS[i]) ? (v ?? false) : v)),
    );
    reply.code(201);
    return rows[0];
  });

  // apply=future_unpaid: leva a mudança aos lançamentos já gerados (mês atual em diante) que não foram pagos
  // nem editados à mão. dry_run=true só conta quantos seriam afetados, sem salvar nada.
  const options = z.object({
    apply: z.enum(['none', 'future_unpaid']).default('none'),
    dry_run: z.boolean().default(false),
    from_month: z.string().regex(MONTH_RE).optional(),
  });
  const update = async (req: { params: { id: string }; body: unknown }) => {
    const opts = options.parse(req.body ?? {});
    const b = normalizeRecurring(recurringSchema.parse(req.body));
    const vals = COLS.map((c) => (b as Record<string, unknown>)[c] ?? (c === 'active' ? true : c === 'frequency' ? 'monthly' : null));
    const params = [req.params.id, ...vals.map((v, i) => (['is_estimate', 'needs_review'].includes(COLS[i]) ? (v ?? false) : v))];
    const sql = `update recurring_items set ${COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')} where id = $1 returning *`;
    return withTx(async (c) => {
      const { rows } = await c.query(sql, params);
      if (!rows[0]) throw notFound();
      const propagated = opts.apply === 'future_unpaid' ? await propagateRecurring(c, rows[0].id, { dryRun: opts.dry_run, fromMonth: opts.from_month }) : null;
      if (opts.dry_run) {
        // Prévia: desfaz a gravação da própria recorrência.
        await c.query('rollback');
        await c.query('begin');
        return { dry_run: true, propagated };
      }
      return { ...rows[0], propagated };
    });
  };
  app.put<{ Params: { id: string } }>('/recurring/:id', update);
  app.patch<{ Params: { id: string } }>('/recurring/:id', update);

  app.delete<{ Params: { id: string } }>('/recurring/:id', async (req, reply) => {
    await pool.query('delete from recurring_items where id = $1', [req.params.id]);
    reply.code(204);
  });

  /** Cria os lançamentos agendados das recorrências para o mês (idempotente). */
  app.post<{ Params: { month: string } }>('/months/:month/ensure', async (req, reply) => {
    if (!MONTH_RE.test(req.params.month)) {
      reply.code(400);
      return { error: 'Mês inválido (use AAAA-MM).' };
    }
    return { created: await ensureMonth(pool, req.params.month) };
  });
}
