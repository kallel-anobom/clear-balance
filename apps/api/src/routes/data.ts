import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import type { Queryable } from '../db.js';
import { notFound } from '../errors.js';
import { syncInvoicePaid } from '../services/invoices.js';

export async function dataRoutes(app: FastifyInstance) {
  app.get('/data/summary', async () => {
    const { rows } = await pool.query(`
      select
        (select count(*) from transactions)::int as transactions,
        (select count(*) from transactions where import_batch_id is not null)::int as imported_transactions,
        (select count(*) from import_batches)::int as import_batches,
        (select count(*) from invoices)::int as invoices,
        (select count(*) from accounts)::int as accounts,
        (select count(*) from cards)::int as cards,
        (select count(*) from learned_rules)::int as learned_rules,
        (select count(*) from budgets)::int as budgets`);
    return rows[0];
  });

  app.get('/data/imports', async () => {
    const { rows } = await pool.query(
      `select b.*, (select count(*) from transactions t where t.import_batch_id = b.id)::int as transactions
       from import_batches b order by b.created_at desc`,
    );
    return rows;
  });

  /** Apaga uma importação e todos os lançamentos criados por ela. */
  app.delete<{ Params: { id: string } }>('/data/imports/:id', async (req) => {
    return withTx(async (c) => {
      const { rows } = await c.query(
        'select distinct invoice_id from transactions where import_batch_id = $1 and invoice_id is not null',
        [req.params.id],
      );
      const del = await c.query('delete from import_batches where id = $1 returning id', [req.params.id]);
      if (!del.rows[0]) throw notFound();
      await removeEmptyInvoices(c, rows.map((r) => r.invoice_id));
      return { deleted: true };
    });
  });

  /** Apaga tudo que veio de importações (CSV/PDF), mantendo o que foi digitado à mão. */
  app.delete('/data/imports', async () => {
    return withTx(async (c) => {
      const { rows } = await c.query(
        'select distinct invoice_id from transactions where import_batch_id is not null and invoice_id is not null',
      );
      const del = await c.query('delete from import_batches returning id');
      await removeEmptyInvoices(c, rows.map((r) => r.invoice_id));
      return { deleted_batches: del.rowCount };
    });
  });

  /** Apaga todos os dados financeiros (mantém as categorias). Exige confirmação explícita. */
  app.post('/data/wipe', async (req, reply) => {
    const b = z.object({ confirm: z.literal('APAGAR TUDO') }).safeParse(req.body);
    if (!b.success) {
      reply.code(400);
      return { error: 'Confirmação ausente: envie confirm = "APAGAR TUDO".' };
    }
    await withTx(async (c) => {
      await c.query(`truncate transactions, invoices, import_batches, recurring_skips, recurring_items, cards, accounts, learned_rules, budgets restart identity cascade`);
      await c.query(`delete from settings where key = 'seeded'`);
    });
    return { wiped: true };
  });
}

/** Remove faturas que ficaram sem compras, sem pagamento e sem total confirmado. */
async function removeEmptyInvoices(c: Queryable, ids: number[]) {
  if (!ids.length) return;
  for (const id of ids) await syncInvoicePaid(c, id); // pagamentos importados apagados deixam a fatura "não paga"
  await c.query(
    `delete from invoices i where i.id = any($1::int[]) and i.statement_total_cents is null and i.paid_on is null
       and not exists (select 1 from transactions t where t.invoice_id = i.id)`,
    [ids],
  );
}
