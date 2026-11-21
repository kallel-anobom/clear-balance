import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, withTx } from '../db.js';
import { HttpError, badRequest, notFound } from '../errors.js';
import { isValidDate, todayISO } from '../lib.js';
import { invoiceAmount, type InvoiceRow } from '../services/overview.js';
import { invoiceDatesForDue, findOrCreateInvoice, invoiceForPurchase, syncInvoicePaid } from '../services/invoices.js';
import { suggestPaymentLinks } from '../services/paymentLinks.js';
import { createTransaction } from '../services/transactions.js';

const date = z.string().refine(isValidDate, 'Data inválida.');

const INVOICE_SELECT = `
  select i.*, cd.name as card_name, cd.last4 as card_last4,
    coalesce((select sum(t.total_cents) from transactions t where t.invoice_id = i.id and t.type = 'expense'), 0) as lines_total_cents,
    coalesce((select sum(coalesce(t.my_share_cents, t.total_cents)) from transactions t where t.invoice_id = i.id and t.type = 'expense'), 0) as lines_mine_cents,
    (select count(*) from transactions t where t.invoice_id = i.id and t.type = 'expense')::int as lines_count
  from invoices i join cards cd on cd.id = i.card_id`;

function decorate(row: InvoiceRow & { closing_date: string | null }) {
  const today = todayISO();
  const { cents, estimated } = invoiceAmount(row);
  const status = row.paid_on ? 'paid' : row.closing_date && row.closing_date < today ? 'closed' : 'open';
  return {
    ...row,
    amount_cents: cents,
    amount_estimated: estimated,
    status,
    overdue: !row.paid_on && row.due_date < today,
    // Diferença entre o total da fatura informado e a soma das compras lançadas (conferência).
    mismatch_cents: row.statement_total_cents !== null ? row.statement_total_cents - row.lines_total_cents : null,
  };
}

export async function invoiceRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { card_id?: string } }>('/invoices', async (req) => {
    const params: unknown[] = [];
    let where = '';
    if (req.query.card_id) {
      params.push(Number(req.query.card_id));
      where = 'where i.card_id = $1';
    }
    const { rows } = await pool.query(`${INVOICE_SELECT} ${where} order by i.due_date desc`, params);
    const unlinked = await pool.query(
      `select t.id, t.description, t.total_cents, t.paid_on, t.card_id, t.account_id, a.name as account_name
       from transactions t left join accounts a on a.id = t.account_id
       where t.type = 'invoice_payment' and t.invoice_id is null order by t.paid_on desc nulls last`,
    );
    // Sugestão de vínculo: usa as faturas em aberto de todos os cartões (não só do filtro da tela).
    let openInvoices = rows;
    if (req.query.card_id) openInvoices = (await pool.query(`${INVOICE_SELECT} order by i.due_date desc`)).rows;
    const linkable = openInvoices
      .map(decorate)
      .filter((i) => i.status !== 'paid')
      .map((i) => ({ id: i.id, card_id: i.card_id, card_name: i.card_name, due_date: i.due_date, amount_cents: i.amount_cents }));
    const links = suggestPaymentLinks(unlinked.rows, linkable);
    return {
      invoices: rows.map(decorate),
      unlinked_payments: unlinked.rows.map((p) => ({ ...p, ...links.get(p.id) })),
      // Faturas em aberto de todos os cartões, para escolher o vínculo (independe do cartão filtrado na tela).
      linkable_invoices: linkable,
    };
  });

  app.get<{ Params: { id: string } }>('/invoices/:id', async (req) => {
    const { rows } = await pool.query(`${INVOICE_SELECT} where i.id = $1`, [req.params.id]);
    if (!rows[0]) throw notFound();
    const purchases = await pool.query(
      `select t.*, c.name as category_name from transactions t left join categories c on c.id = t.category_id
       where t.invoice_id = $1 and t.type = 'expense' order by t.occurred_on, t.id`,
      [req.params.id],
    );
    const payments = await pool.query(
      `select t.*, a.name as account_name from transactions t left join accounts a on a.id = t.account_id
       where t.invoice_id = $1 and t.type = 'invoice_payment' order by t.paid_on`,
      [req.params.id],
    );
    return { ...decorate(rows[0]), purchases: purchases.rows, payments: payments.rows };
  });

  // Cria uma fatura manualmente (ex.: só o total e o vencimento, sem lançar as compras).
  app.post('/invoices', async (req, reply) => {
    const b = z
      .object({
        card_id: z.number().int().positive(),
        due_date: date,
        closing_date: date.nullable().optional(),
        statement_total_cents: z.number().int().nullable().optional(),
      })
      .parse(req.body);
    const { rows: cards } = await pool.query('select closing_day, due_day from cards where id = $1', [b.card_id]);
    if (!cards[0]) throw badRequest('Cartão não encontrado.');
    const dates = invoiceDatesForDue(cards[0], b.due_date);
    const id = await findOrCreateInvoice(pool, b.card_id, { closing_date: b.closing_date ?? dates.closing_date, due_date: b.due_date });
    if (b.statement_total_cents != null) await pool.query('update invoices set statement_total_cents = $2 where id = $1', [id, b.statement_total_cents]);
    reply.code(201);
    return { id };
  });

  /**
   * Valor parcial da fatura aberta (o total que o app do banco mostra hoje), para cartões cuja fatura só dá para
   * baixar depois do fechamento. Sem `invoice_id`, usa a fatura aberta do cartão (ou cria a do ciclo atual).
   * `partial_cents: null` remove o valor. Nunca vale como total confirmado.
   */
  app.put('/invoices/partial', async (req) => {
    const b = z
      .object({
        card_id: z.number().int().positive(),
        invoice_id: z.number().int().positive().optional(),
        partial_cents: z.number().int().min(0).max(1_000_000_000).nullable(),
      })
      .parse(req.body);
    const today = todayISO();
    return withTx(async (c) => {
      let id = b.invoice_id ?? null;
      if (id === null) {
        const open = await c.query(
          `select id from invoices
           where card_id = $1 and paid_on is null and statement_total_cents is null and (closing_date is null or closing_date >= $2)
           order by due_date limit 1`,
          [b.card_id, today],
        );
        id = open.rows[0]?.id ?? (b.partial_cents === null ? null : await invoiceForPurchase(c, b.card_id, today));
      }
      if (id === null) throw notFound();
      const { rows } = await c.query('select card_id, paid_on, statement_total_cents, due_date from invoices where id = $1', [id]);
      const inv = rows[0];
      if (!inv || inv.card_id !== b.card_id) throw notFound();
      if (b.partial_cents !== null) {
        if (inv.paid_on) throw badRequest('Esta fatura já está paga.');
        if (inv.statement_total_cents !== null) throw badRequest('Esta fatura já tem o total confirmado; edite o total em vez do valor parcial.');
      }
      await c.query(
        'update invoices set partial_total_cents = $2, partial_on = case when $2::bigint is null then null else $3::date end where id = $1',
        [id, b.partial_cents, today],
      );
      return { id, due_date: inv.due_date, partial_total_cents: b.partial_cents, partial_on: b.partial_cents === null ? null : today };
    });
  });

  app.patch<{ Params: { id: string } }>('/invoices/:id', async (req) => {
    const b = z
      .object({
        statement_total_cents: z.number().int().nullable().optional(),
        closing_date: date.nullable().optional(),
        due_date: date.optional(),
      })
      .parse(req.body);
    const { rows } = await pool.query(
      `update invoices set
         statement_total_cents = case when $2::boolean then $3 else statement_total_cents end,
         -- Total confirmado vale mais que o parcial: o parcial sai de cena.
         partial_total_cents = case when $2::boolean and $3::bigint is not null then null else partial_total_cents end,
         partial_on = case when $2::boolean and $3::bigint is not null then null else partial_on end,
         closing_date = case when $4::boolean then $5 else closing_date end,
         due_date = coalesce($6, due_date)
       where id = $1 returning id`,
      [
        req.params.id,
        'statement_total_cents' in b, b.statement_total_cents ?? null,
        'closing_date' in b, b.closing_date ?? null,
        b.due_date ?? null,
      ],
    );
    if (!rows[0]) throw notFound();
    return { id: rows[0].id };
  });

  /**
   * Paga a fatura: cria UM lançamento de saída de caixa (pagamento da fatura).
   * As compras da fatura continuam sendo os gastos — o pagamento nunca entra como despesa.
   */
  app.post<{ Params: { id: string } }>('/invoices/:id/pay', async (req, reply) => {
    const b = z
      .object({
        account_id: z.number().int().positive(),
        paid_on: date.default(() => todayISO()),
        amount_cents: z.number().int().positive().optional(),
      })
      .parse(req.body);
    return withTx(async (c) => {
      const { rows } = await c.query(`${INVOICE_SELECT} where i.id = $1`, [req.params.id]);
      if (!rows[0]) throw notFound();
      const inv = decorate(rows[0]);
      const tx = await createTransaction(c, {
        type: 'invoice_payment',
        description: `Pagamento da fatura ${inv.card_name}`,
        account_id: b.account_id,
        invoice_id: inv.id,
        status: 'paid',
        paid_on: b.paid_on,
        occurred_on: b.paid_on,
        total_cents: b.amount_cents ?? inv.amount_cents,
        is_estimate: inv.amount_estimated && b.amount_cents === undefined,
        needs_review: inv.amount_estimated && b.amount_cents === undefined,
        review_note: inv.amount_estimated && b.amount_cents === undefined ? 'Valor calculado pelas compras lançadas; confirme com a fatura.' : null,
      });
      await syncInvoicePaid(c, inv.id);
      reply.code(201);
      return tx;
    });
  });

  app.delete<{ Params: { id: string } }>('/invoices/:id', async (req, reply) => {
    const { rows } = await pool.query(
      `select (select count(*) from transactions where invoice_id = $1)::int as n`,
      [req.params.id],
    );
    if (rows[0].n > 0) throw new HttpError(409, 'A fatura tem compras ou pagamentos vinculados. Apague-os ou mova-os antes.');
    await pool.query('delete from invoices where id = $1', [req.params.id]);
    reply.code(204);
  });
}
