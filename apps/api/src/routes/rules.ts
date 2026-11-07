import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { merchantKey } from '../importer/classify.js';

const TYPES = ['income', 'expense', 'transfer', 'reimbursement', 'invoice_payment', 'overdraft_payment'] as const;

const ruleBody = z.object({
  kind: z.enum(['account', 'card']),
  pattern: z.string().trim().min(1).max(80),
  category_id: z.number().int().positive().nullable().optional(),
  type: z.enum(TYPES).nullable().optional(),
  ignore: z.boolean().optional(),
});

const SELECT = `select r.*, c.name as category_name from learned_rules r left join categories c on c.id = r.category_id`;

/** Regras aprendidas com as correções feitas nas importações. Só contêm nome de estabelecimento e classificação. */
export async function ruleRoutes(app: FastifyInstance) {
  app.get('/rules', async () => (await pool.query(`${SELECT} order by r.last_used_at desc, r.id desc`)).rows);

  app.post('/rules', async (req, reply) => {
    const b = ruleBody.parse(req.body);
    const pattern = merchantKey(b.pattern);
    if (!pattern) throw badRequest('Informe o nome do estabelecimento (pelo menos 3 letras, sem números).');
    const { rows } = await pool.query(
      `insert into learned_rules (kind, pattern, category_id, type, ignore) values ($1,$2,$3,$4,$5)
       on conflict (kind, pattern) do update set category_id = excluded.category_id, type = excluded.type, ignore = excluded.ignore, last_used_at = now()
       returning id`,
      [b.kind, pattern, b.category_id ?? null, b.type ?? null, b.ignore ?? false],
    );
    reply.code(201);
    return (await pool.query(`${SELECT} where r.id = $1`, [rows[0].id])).rows[0];
  });

  app.patch<{ Params: { id: string } }>('/rules/:id', async (req) => {
    const b = ruleBody.partial().omit({ kind: true }).parse(req.body);
    const sets: string[] = [];
    const vals: unknown[] = [];
    const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if (b.pattern !== undefined) {
      const pattern = merchantKey(b.pattern);
      if (!pattern) throw badRequest('Nome do estabelecimento inválido.');
      add('pattern', pattern);
    }
    if (b.category_id !== undefined) add('category_id', b.category_id);
    if (b.type !== undefined) add('type', b.type);
    if (b.ignore !== undefined) add('ignore', b.ignore);
    if (!sets.length) throw badRequest('Nada para alterar.');
    vals.push(req.params.id);
    try {
      const { rows } = await pool.query(`update learned_rules set ${sets.join(', ')} where id = $${vals.length} returning id`, vals);
      if (!rows[0]) throw notFound();
      return (await pool.query(`${SELECT} where r.id = $1`, [rows[0].id])).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw badRequest('Já existe uma regra para este estabelecimento.');
      throw e;
    }
  });

  app.delete<{ Params: { id: string } }>('/rules/:id', async (req) => {
    const { rowCount } = await pool.query('delete from learned_rules where id = $1', [req.params.id]);
    if (!rowCount) throw notFound();
    return { deleted: true };
  });

  /** Esquecer tudo o que foi aprendido. */
  app.delete('/rules', async () => {
    const { rowCount } = await pool.query('delete from learned_rules');
    return { deleted: rowCount };
  });
}
