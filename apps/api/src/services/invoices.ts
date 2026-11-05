import type { Queryable } from '../db.js';
import { addMonths, clampedDate, monthOf } from '../lib.js';

export interface CardDays {
  closing_day: number;
  due_day: number;
}

const ymd = (date: string) => date.split('-').map(Number) as [number, number, number];

/**
 * A qual fatura uma compra pertence, a partir do dia de fechamento e vencimento do cartão.
 * Compra até o dia do fechamento (inclusive) entra na fatura que fecha neste mês; depois, na do mês seguinte.
 * O vencimento cai no mesmo mês do fechamento se o dia de vencimento for maior que o de fechamento; senão, no mês seguinte.
 */
export function invoiceDatesForPurchase(card: CardDays, purchaseDate: string) {
  const [y, m, d] = ymd(purchaseDate);
  const closeThisMonth = clampedDate(y, m, card.closing_day);
  const closingMonth = purchaseDate <= closeThisMonth ? monthOf(purchaseDate) : addMonths(monthOf(purchaseDate), 1);
  return datesFromClosingMonth(card, closingMonth);
}

/** Datas da fatura quando o usuário informa o vencimento (ex.: lido na própria fatura). */
export function invoiceDatesForDue(card: CardDays, dueDate: string) {
  const dueMonth = monthOf(dueDate);
  const closingMonth = card.due_day > card.closing_day ? dueMonth : addMonths(dueMonth, -1);
  const [cy, cm] = closingMonth.split('-').map(Number);
  return { closing_date: clampedDate(cy, cm, card.closing_day), due_date: dueDate };
}

function datesFromClosingMonth(card: CardDays, closingMonth: string) {
  const [cy, cm] = closingMonth.split('-').map(Number);
  const closing_date = clampedDate(cy, cm, card.closing_day);
  const dueMonth = card.due_day > card.closing_day ? closingMonth : addMonths(closingMonth, 1);
  const [dy, dm] = dueMonth.split('-').map(Number);
  return { closing_date, due_date: clampedDate(dy, dm, card.due_day) };
}

export async function findOrCreateInvoice(
  db: Queryable,
  cardId: number,
  dates: { closing_date: string | null; due_date: string },
): Promise<number> {
  await db.query(
    `insert into invoices (card_id, closing_date, due_date) values ($1, $2, $3)
     on conflict (card_id, due_date) do nothing`,
    [cardId, dates.closing_date, dates.due_date],
  );
  const { rows } = await db.query('select id from invoices where card_id = $1 and due_date = $2', [cardId, dates.due_date]);
  return rows[0].id;
}

export async function invoiceForPurchase(db: Queryable, cardId: number, purchaseDate: string): Promise<number | null> {
  const { rows } = await db.query('select closing_day, due_day from cards where id = $1', [cardId]);
  if (!rows[0]) return null;
  return findOrCreateInvoice(db, cardId, invoiceDatesForPurchase(rows[0], purchaseDate));
}

/** Mantém invoices.paid_on coerente com os pagamentos vinculados. */
export async function syncInvoicePaid(db: Queryable, invoiceId: number | null) {
  if (!invoiceId) return;
  await db.query(
    `update invoices set paid_on = (
       select max(paid_on) from transactions
       where invoice_id = $1 and type = 'invoice_payment' and status = 'paid')
     where id = $1`,
    [invoiceId],
  );
}
