import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { badRequest, notFound } from '../errors.js';

const body = z.object({ limit_cents: z.number().int().positive().max(100_000_000_00) });

/** Orçamento por categoria de despesa: um teto mensal fixo por categoria. */
export async function budgetRoutes(app: FastifyInstance) {
  app.get('/budgets', async () =>
    (await pool.query(
      `select b.category_id, c.name as category_name, c.slug as category_slug, b.limit_cents
       from budgets b join categories c on c.id = b.category_id order by c.name`,
    )).rows,
  );

  app.put<{ Params: { categoryId: string } }>('/budgets/:categoryId', async (req) => {
    const { limit_cents } = body.parse(req.body);
    const id = Number(req.params.categoryId);
    const cat = await pool.query('select kind from categories where id = $1', [id]);
    if (!cat.rows[0]) throw notFound('Categoria não encontrada.');
    if (cat.rows[0].kind !== 'expense') throw badRequest('Orçamento só vale para categorias de despesa.');
    const { rows } = await pool.query(
      `insert into budgets (category_id, limit_cents) values ($1, $2)
       on conflict (category_id) do update set limit_cents = excluded.limit_cents, updated_at = now()
       returning category_id, limit_cents`,
      [id, limit_cents],
    );
    return rows[0];
  });

  app.delete<{ Params: { categoryId: string } }>('/budgets/:categoryId', async (req) => {
    const { rowCount } = await pool.query('delete from budgets where category_id = $1', [Number(req.params.categoryId)]);
    if (!rowCount) throw notFound('Esta categoria não tem orçamento.');
    return { deleted: true };
  });
}
