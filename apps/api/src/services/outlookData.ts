import { pool } from '../db.js';
import { addMonths, clampedDate, monthBounds, monthOf, todayISO } from '../lib.js';
import { invoiceDatesForDue } from './invoices.js';
import { buildOutlookMonth, estimateInvoice, HISTORY_INVOICES, type InvoiceInfo, type OutlookMonth } from './outlook.js';
import { buildOverview } from './overviewData.js';

interface InvoiceAgg extends InvoiceInfo { paid_on: string | null }

const agg = (today: string) => `
  coalesce(sum(t.total_cents) filter (where t.installment_group is not null or t.recurring_id is not null), 0) as fixed_cents,
  coalesce(sum(t.total_cents) filter (where t.installment_group is null and t.recurring_id is null), 0) as variable_cents,
  count(t.id)::int as lines_count,
  max(t.occurred_on) filter (where not t.is_projected and t.occurred_on <= ${today}) as last_purchase_on`;

export const MAX_OUTLOOK_MONTHS = 6;

/** Quanto vai sair da conta em cada um dos próximos meses, com a estimativa das faturas ao fechar. */
export async function loadOutlook(from: string, months: number, today: string = todayISO()): Promise<{ from: string; months: OutlookMonth[] }> {
  const list = Array.from({ length: months }, (_, i) => addMonths(from, i));
  const start = monthBounds(list[0]).start;
  const end = monthBounds(list[list.length - 1]).end;

  const [due, closed, cards, overviews] = await Promise.all([
    pool.query(
      `select i.id as invoice_id, i.card_id, c.name as card_name, i.due_date, i.closing_date, i.statement_total_cents, i.partial_total_cents, i.partial_on, i.paid_on, ${agg('$3')}
       from invoices i join cards c on c.id = i.card_id
       left join transactions t on t.invoice_id = i.id and t.type = 'expense'
       where i.due_date between $1 and $2
       group by i.id, c.name`,
      [start, end, today],
    ),
    // Faturas já fechadas: base da média da parte variável.
    pool.query(
      `select i.card_id, i.statement_total_cents, ${agg('$1')}
       from invoices i left join transactions t on t.invoice_id = i.id and t.type = 'expense'
       where coalesce(i.closing_date, i.due_date) < $1
       group by i.id order by coalesce(i.closing_date, i.due_date) desc`,
      [today],
    ),
    pool.query('select id, name, closing_day, due_day from cards order by name'),
    Promise.all(list.map((m) => buildOverview(m, today))),
  ]);

  // Parte variável das últimas faturas fechadas, por cartão (mais recente primeiro).
  const history = new Map<number, number[]>();
  for (const r of closed.rows) {
    const variable = r.statement_total_cents !== null ? Math.max(0, r.statement_total_cents - r.fixed_cents) : r.variable_cents;
    if (r.lines_count === 0 && r.statement_total_cents === null) continue;
    const h = history.get(r.card_id) ?? [];
    if (h.length < HISTORY_INVOICES) history.set(r.card_id, [...h, variable]);
  }

  const invoices = due.rows as InvoiceAgg[];
  return {
    from,
    months: list.map((month, idx) => {
      const ov = overviews[idx];
      const estimates = invoices
        .filter((i) => i.paid_on === null && monthOf(i.due_date) === month)
        .map((i) => estimateInvoice(i, history.get(i.card_id) ?? [], today));
      // Cartão sem fatura neste vencimento ainda: estima só pela média, se houver histórico.
      for (const card of cards.rows) {
        if (invoices.some((i) => i.card_id === card.id && monthOf(i.due_date) === month)) continue;
        const dueDate = clampedDate(Number(month.slice(0, 4)), Number(month.slice(5, 7)), card.due_day);
        if (dueDate < today || !(history.get(card.id)?.length)) continue;
        const closing = invoiceDatesForDue(card, dueDate).closing_date;
        if (closing < today) continue; // ciclo já fechado sem nenhuma compra: não há fatura a pagar
        const info: InvoiceInfo = {
          invoice_id: null, card_id: card.id, card_name: card.name, due_date: dueDate,
          closing_date: closing, statement_total_cents: null,
          fixed_cents: 0, variable_cents: 0, lines_count: 0, last_purchase_on: null,
        };
        estimates.push(estimateInvoice(info, history.get(card.id)!, today));
      }
      return buildOutlookMonth({ month, today, paid_cents: ov.cash.paid_cents, cash_items: ov.cash.items, invoices: estimates });
    }),
  };
}
