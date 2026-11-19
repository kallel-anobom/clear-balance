import { describe, expect, it } from 'vitest';
import { buildOutlookMonth, estimateInvoice, type InvoiceInfo } from '../src/services/outlook.js';
import type { FlowItem } from '../src/services/overview.js';

const inv = (p: Partial<InvoiceInfo> = {}): InvoiceInfo => ({
  invoice_id: 1, card_id: 1, card_name: 'Cartão A', due_date: '2026-12-10', closing_date: '2026-12-03', statement_total_cents: null,
  fixed_cents: 0, variable_cents: 0, lines_count: 0, last_purchase_on: null, ...p,
});
const TODAY = '2026-11-19';

describe('estimateInvoice', () => {
  it('fatura aberta: parcelas + o maior entre o variável lançado e a média das 3 últimas', () => {
    const e = estimateInvoice(inv({ fixed_cents: 20000, variable_cents: 30000, lines_count: 5, last_purchase_on: '2026-11-18' }), [100000, 80000, 90000, 999999], TODAY);
    expect(e).toMatchObject({ basis: 'estimate', committed_cents: 50000, avg_variable_cents: 90000, history_count: 3, estimated_cents: 110000 });
  });

  it('se já lançou mais que a média, vale o lançado (nunca estima abaixo do que existe)', () => {
    const e = estimateInvoice(inv({ fixed_cents: 10000, variable_cents: 150000, lines_count: 9, last_purchase_on: TODAY }), [100000, 100000], TODAY);
    expect(e.estimated_cents).toBe(160000);
    expect(e.committed_cents).toBe(160000);
  });

  it('sem histórico só mostra o lançado, sem inventar estimativa', () => {
    const e = estimateInvoice(inv({ variable_cents: 30000, lines_count: 3, last_purchase_on: TODAY }), [], TODAY);
    expect(e).toMatchObject({ basis: 'launched_only', estimated_cents: 30000, avg_variable_cents: null, history_count: 0 });
  });

  it('histórico zerado não conta (fatura vazia não puxa a média para baixo)', () => {
    const e = estimateInvoice(inv({ variable_cents: 1000, lines_count: 1, last_purchase_on: TODAY }), [0, 60000], TODAY);
    expect(e).toMatchObject({ history_count: 1, avg_variable_cents: 60000, estimated_cents: 60000 });
  });

  it('total confirmado ou fatura fechada usam o valor real, sem estimativa', () => {
    expect(estimateInvoice(inv({ statement_total_cents: 123456, variable_cents: 10 }), [99999], TODAY))
      .toMatchObject({ basis: 'confirmed', committed_cents: 123456, estimated_cents: 123456, is_stale: false });
    const closed = estimateInvoice(inv({ closing_date: '2026-11-03', due_date: '2026-11-10', variable_cents: 70000, fixed_cents: 5000, lines_count: 8 }), [99999], TODAY);
    expect(closed).toMatchObject({ basis: 'closed', committed_cents: 75000, estimated_cents: 75000 });
  });

  it('frescor: avisa quando o último lançamento tem mais de 3 dias, ou não há nenhum', () => {
    const base = { variable_cents: 10000, lines_count: 1 };
    expect(estimateInvoice(inv({ ...base, last_purchase_on: '2026-11-17' }), [50000], TODAY)).toMatchObject({ stale_days: 2, is_stale: false });
    expect(estimateInvoice(inv({ ...base, last_purchase_on: '2026-11-10' }), [50000], TODAY)).toMatchObject({ stale_days: 9, is_stale: true });
    expect(estimateInvoice(inv({ fixed_cents: 5000, lines_count: 1 }), [50000], TODAY)).toMatchObject({ stale_days: null, is_stale: true });
  });

  it('ciclo que ainda não começou não é "defasado" (não existe compra possível)', () => {
    // Fatura de janeiro: fecha em 03/01, o ciclo começa em 04/12.
    const e = estimateInvoice(inv({ due_date: '2027-01-10', closing_date: '2027-01-03' }), [50000], TODAY);
    expect(e).toMatchObject({ basis: 'estimate', estimated_cents: 50000, is_stale: false });
  });
});

describe('buildOutlookMonth', () => {
  const item = (p: Partial<FlowItem>): FlowItem => ({
    key: 'k', kind: 'conta', label: 'Aluguel', date: '2026-12-05', amount_cents: 200000, status: 'pending', estimated: false,
    date_confirmed: true, overdue: false, tx_id: 1, invoice_id: null, ...p,
  });

  it('troca as faturas do fluxo pelas estimativas e soma contas pendentes', () => {
    const e = estimateInvoice(inv({ fixed_cents: 20000, variable_cents: 30000, lines_count: 4, last_purchase_on: '2026-11-18' }), [100000], TODAY);
    const m = buildOutlookMonth({
      month: '2026-12', today: TODAY, paid_cents: 0,
      cash_items: [
        item({}),
        item({ key: 'inv-1', kind: 'fatura', label: 'Fatura Cartão A', amount_cents: 50000, estimated: true, tx_id: null, invoice_id: 1 }),
        item({ key: 'paid', status: 'paid', amount_cents: 999 }),
      ],
      invoices: [e],
    });
    expect(m).toMatchObject({ is_current: false, other_cents: 200000, committed_cents: 250000, estimated_cents: 320000, has_estimates: true });
    expect(m.other_items).toHaveLength(1); // a fatura do fluxo e o item já pago ficam de fora
  });

  it('mês atual mostra o que já saiu; sem faturas e sem estimativas não há aviso', () => {
    const m = buildOutlookMonth({ month: '2026-11', today: TODAY, paid_cents: 5000, cash_items: [item({ estimated: false })], invoices: [] });
    expect(m).toMatchObject({ is_current: true, paid_cents: 5000, committed_cents: 200000, estimated_cents: 200000, has_estimates: false, stale_count: 0 });
  });

  it('conta quantas faturas estão defasadas', () => {
    const stale = estimateInvoice(inv({ variable_cents: 1, lines_count: 1, last_purchase_on: '2026-11-01' }), [50000], TODAY);
    const fresh = estimateInvoice(inv({ card_id: 2, card_name: 'Cartão B', variable_cents: 1, lines_count: 1, last_purchase_on: TODAY }), [50000], TODAY);
    expect(buildOutlookMonth({ month: '2026-12', today: TODAY, paid_cents: 0, cash_items: [], invoices: [stale, fresh] }).stale_count).toBe(1);
  });
});
