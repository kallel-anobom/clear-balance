import type { Queryable } from '../db.js';
import { addMonths, clampedDate, monthOf } from '../lib.js';
import { detectInstallment } from '../importer/installments.js';
import { findOrCreateInvoice, invoiceDatesForDue, type CardDays } from './invoices.js';
import { createTransaction } from './transactions.js';

/** Descrição sem o marcador "PARC 03/10" — a mesma para todas as parcelas da compra. */
export const baseDescription = (description: string) => detectInstallment(description)?.base ?? description;

const fmt = (cents: number) => (cents / 100).toFixed(2).replace('.', ',');

/**
 * Parcelas posteriores à primeira costumam trazer a data da compra ORIGINAL. Para não puxar a parcela
 * para a fatura/mês errados, usa-se a data do extrato se ela cair dentro do ciclo da fatura; senão, a data de fechamento.
 */
export function dateInInvoiceCycle(card: CardDays, closingDate: string | null, date: string): string {
  if (!closingDate) return date;
  const [cy, cm] = closingDate.split('-').map(Number);
  const [py, pm] = addMonths(`${cy}-${String(cm).padStart(2, '0')}`, -1).split('-').map(Number);
  const prevClosing = clampedDate(py, pm, card.closing_day);
  return date > prevClosing && date <= closingDate ? date : closingDate;
}

/**
 * Cria as parcelas restantes (n+1..N) como PREVISTAS, uma por fatura seguinte. São estimativas: mesmo valor da
 * parcela atual, na fatura de vencimento correspondente. Nada é marcado como pago e nenhuma data é inventada
 * além da data de fechamento da fatura em que a parcela deve cair.
 */
export async function projectInstallments(db: Queryable, txId: number): Promise<number> {
  const { rows } = await db.query(
    `select t.*, i.due_date as inv_due, cd.closing_day, cd.due_day
     from transactions t
       join cards cd on cd.id = t.card_id
       join invoices i on i.id = t.invoice_id
     where t.id = $1`,
    [txId],
  );
  const t = rows[0];
  if (!t || !t.installment_group || !t.installment_total || t.installment_no >= t.installment_total) return 0;

  const base = baseDescription(t.description);
  const dueDay = Number(String(t.inv_due).slice(8, 10));
  const dueMonth = monthOf(t.inv_due);
  const card: CardDays = { closing_day: t.closing_day, due_day: t.due_day };
  let created = 0;

  for (let k = t.installment_no + 1; k <= t.installment_total; k++) {
    const exists = await db.query('select 1 from transactions where installment_group = $1 and installment_no = $2', [t.installment_group, k]);
    if (exists.rowCount) continue;
    const [y, m] = addMonths(dueMonth, k - t.installment_no).split('-').map(Number);
    const dates = invoiceDatesForDue(card, clampedDate(y, m, dueDay));
    const invoiceId = await findOrCreateInvoice(db, t.card_id, dates);
    const inv = (await db.query('select closing_date from invoices where id = $1', [invoiceId])).rows[0];
    await createTransaction(db, {
      type: 'expense',
      description: `${base} - parcela ${k}/${t.installment_total}`,
      category_id: t.category_id,
      card_id: t.card_id,
      invoice_id: invoiceId,
      status: 'scheduled',
      occurred_on: inv?.closing_date ?? dates.closing_date,
      date_confirmed: false,
      total_cents: t.total_cents,
      my_share_cents: t.my_share_cents,
      shared_with: t.shared_with,
      is_estimate: true,
      notes: 'Parcela projetada automaticamente a partir de uma parcela anterior. Será confirmada quando aparecer na fatura.',
      import_batch_id: t.import_batch_id,
      installment_no: k,
      installment_total: t.installment_total,
      installment_group: t.installment_group,
      is_projected: true,
    });
    created++;
  }
  return created;
}

/** A parcela real apareceu na fatura: confirma a parcela projetada (valor, data e descrição reais) sem duplicar. */
export async function confirmProjectedInstallment(
  db: Queryable,
  projectedId: number,
  real: { date: string; description: string; signed_cents: number; hash: string | null; batch_id: number | null; forced_invoice_id: number | null },
) {
  const { rows } = await db.query(
    `select t.*, cd.closing_day, cd.due_day from transactions t join cards cd on cd.id = t.card_id where t.id = $1`,
    [projectedId],
  );
  const ex = rows[0];
  if (!ex) return null;
  const invoiceId = real.forced_invoice_id ?? ex.invoice_id;
  const inv = invoiceId ? (await db.query('select closing_date from invoices where id = $1', [invoiceId])).rows[0] : null;
  const occurred = dateInInvoiceCycle({ closing_day: ex.closing_day, due_day: ex.due_day }, inv?.closing_date ?? null, real.date);
  const unshared = ex.my_share_cents === null || ex.my_share_cents === ex.total_cents;
  const mine = unshared ? real.signed_cents : Math.min(ex.my_share_cents, real.signed_cents);
  const changed = Math.abs(real.signed_cents) !== Math.abs(ex.total_cents);
  await db.query(
    `update transactions set
       status = 'paid', occurred_on = $2, month_ref = $3, date_confirmed = true, is_estimate = false, is_projected = false,
       description = $4, total_cents = $5, my_share_cents = $6, invoice_id = $7, import_hash = $8, import_batch_id = $9,
       needs_review = $10, review_note = $11, notes = null, updated_at = now()
     where id = $1`,
    [
      projectedId, occurred, monthOf(occurred), real.description, real.signed_cents, mine, invoiceId, real.hash, real.batch_id,
      changed, changed ? `O valor da parcela mudou de R$ ${fmt(ex.total_cents)} (previsto) para R$ ${fmt(real.signed_cents)} (fatura).` : null,
    ],
  );
  return projectedId;
}

/** Edita valor/categoria/divisão das próximas parcelas AINDA PROJETADAS da mesma compra. */
export async function applyToFollowing(db: Queryable, tx: { id: number; installment_group: string | null; installment_no: number | null; total_cents: number; my_share_cents: number | null; category_id: number | null; shared_with: string | null }) {
  if (!tx.installment_group || !tx.installment_no) return 0;
  const { rowCount } = await db.query(
    `update transactions set total_cents = $3, my_share_cents = $4, category_id = $5, shared_with = $6, updated_at = now()
     where installment_group = $1 and installment_no > $2 and is_projected`,
    [tx.installment_group, tx.installment_no, tx.total_cents, tx.my_share_cents, tx.category_id, tx.shared_with],
  );
  return rowCount ?? 0;
}

/** Apaga as parcelas projetadas seguintes à parcela informada (a própria parcela é apagada pelo chamador). */
export async function deleteFollowing(db: Queryable, id: number) {
  const { rows } = await db.query('select installment_group, installment_no from transactions where id = $1', [id]);
  const t = rows[0];
  if (!t?.installment_group) return 0;
  const { rowCount } = await db.query(
    'delete from transactions where installment_group = $1 and installment_no > $2 and is_projected',
    [t.installment_group, t.installment_no],
  );
  return rowCount ?? 0;
}
