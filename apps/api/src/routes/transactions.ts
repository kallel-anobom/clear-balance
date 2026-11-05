import type { FastifyInstance } from 'fastify';
import { pool, withTx } from '../db.js';
import { MONTH_RE } from '../lib.js';
import {
  TX_SELECT, createTransaction, deleteTransaction, getTransaction, txCreateSchema, txPatchSchema, txTypes, updateTransaction,
} from '../services/transactions.js';
import { badRequest } from '../errors.js';
import { detectInstallment, installmentGroup } from '../importer/installments.js';
import { applyToFollowing, deleteFollowing, projectInstallments } from '../services/installments.js';

interface ListQuery {
  month?: string;
  category_id?: string;
  account_id?: string;
  card_id?: string;
  type?: string;
  status?: string;
  needs_review?: string;
  q?: string;
}

export async function transactionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: ListQuery }>('/transactions', async (req) => {
    const q = req.query;
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.month) {
      if (!MONTH_RE.test(q.month)) throw badRequest('Mês inválido.');
      add('t.month_ref = ?', q.month);
    }
    if (q.category_id === 'none') where.push('t.category_id is null');
    else if (q.category_id) add('t.category_id = ?', Number(q.category_id));
    if (q.account_id) {
      params.push(Number(q.account_id));
      where.push(`(t.account_id = $${params.length} or t.transfer_account_id = $${params.length})`);
    }
    if (q.card_id) add('t.card_id = ?', Number(q.card_id));
    if (q.type) {
      if (!(txTypes as readonly string[]).includes(q.type)) throw badRequest('Tipo inválido.');
      add('t.type = ?', q.type);
    }
    if (q.status === 'paid' || q.status === 'scheduled') add('t.status = ?', q.status);
    if (q.needs_review === 'true') where.push('t.needs_review');
    if (q.q) add(`t.description ilike '%' || ? || '%'`, q.q.slice(0, 80));
    const sql = `
      select x.*,
        case when x.type = 'expense' and x.my_share_cents is not null then x.total_cents - x.my_share_cents else 0 end as others_cents,
        coalesce((select sum(r.total_cents) from transactions r
                  where r.reimbursement_for_id = x.id and r.type = 'reimbursement' and r.status = 'paid'), 0) as reimbursed_cents
      from (${TX_SELECT} ${where.length ? 'where ' + where.join(' and ') : ''}) x
      order by coalesce(x.occurred_on, x.due_date, x.paid_on, (x.month_ref || '-01')::date) desc, x.id desc
      limit 1000`;
    return (await pool.query(sql, params)).rows;
  });

  app.get<{ Params: { id: string } }>('/transactions/:id', async (req) => getTransaction(pool, Number(req.params.id)));

  app.post('/transactions', async (req, reply) => {
    const body = txCreateSchema.parse(req.body);
    const tx = await withTx(async (c) => {
      const input = { ...body } as Parameters<typeof createTransaction>[1];
      const parcelado = body.type === 'expense' && body.card_id && body.installment_total;
      if (parcelado) {
        const base = detectInstallment(body.description)?.base ?? body.description;
        input.installment_no = body.installment_no ?? 1;
        input.installment_group = installmentGroup(body.card_id!, base, body.installment_total!);
      } else {
        input.installment_no = null;
        input.installment_total = null;
      }
      const created = await createTransaction(c, input);
      // Parcelas restantes viram previsões nas próximas faturas.
      if (parcelado) await projectInstallments(c, created.id);
      return created;
    });
    reply.code(201);
    return tx;
  });

  // scope=following: aplica valor/categoria/divisão às próximas parcelas ainda previstas da mesma compra.
  app.patch<{ Params: { id: string }; Querystring: { scope?: string } }>('/transactions/:id', async (req) => {
    const patch = txPatchSchema.parse(req.body);
    return withTx(async (c) => {
      const tx = await updateTransaction(c, Number(req.params.id), patch, { manual: true });
      if (req.query.scope === 'following') await applyToFollowing(c, tx);
      return tx;
    });
  });

  // scope=following: apaga também as próximas parcelas previstas (ainda não apareceram em fatura).
  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>('/transactions/:id', async (req, reply) => {
    await withTx(async (c) => {
      if (req.query.scope === 'following') await deleteFollowing(c, Number(req.params.id));
      await deleteTransaction(c, Number(req.params.id));
    });
    reply.code(204);
  });
}
