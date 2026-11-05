import { describe, expect, it } from 'vitest';
import { computeOverview, type InvoiceRow, type TxRow } from '../src/services/overview.js';

let seq = 0;
const tx = (p: Partial<TxRow>): TxRow => ({
  id: ++seq, type: 'expense', description: 'x', category_id: null, category_name: 'Mercado', category_slug: 'mercado',
  account_id: 1, card_id: null, invoice_id: null, status: 'paid', month_ref: '2026-11', occurred_on: '2026-11-05',
  due_date: null, paid_on: '2026-11-05', date_confirmed: true, total_cents: 10000, my_share_cents: null,
  gross_cents: null, deductions_cents: null, is_estimate: false, needs_review: false, review_note: null, ...p,
});
const run = (txs: TxRow[], extra: Partial<Parameters<typeof computeOverview>[0]> = {}) =>
  computeOverview({
    month: '2026-11', today: '2026-11-10', txs, invoices: [], accounts: [], reimbursements: [], yearlyWithoutMonth: [], ...extra,
  });

describe('fatura de cartão x pagamento da fatura', () => {
  it('conta as compras como gasto e o pagamento só como saída de caixa — nunca os dois como despesa', () => {
    const purchases = [
      tx({ card_id: 1, account_id: null, paid_on: null, occurred_on: '2026-11-02', total_cents: 30000, invoice_id: 7 }),
      tx({ card_id: 1, account_id: null, paid_on: null, occurred_on: '2026-11-03', total_cents: 20000, invoice_id: 7 }),
    ];
    // Pagamento da fatura de outubro, feito em novembro (compras de outubro não são gasto de novembro).
    const payment = tx({ type: 'invoice_payment', total_cents: 90000, card_id: 1, invoice_id: 6, month_ref: '2026-11' });
    const o = run([...purchases, payment]);
    expect(o.spending.realized_mine_cents).toBe(50000); // só as compras de novembro
    expect(o.cash.paid_cents).toBe(90000); // saída de caixa = pagamento
    expect(o.cash.items.map((i) => i.kind)).toEqual(['fatura']); // compras no cartão não são saída de caixa
  });

  it('fatura aberta vencendo no mês entra como saída pendente; estimada se o total não foi confirmado', () => {
    const inv: InvoiceRow = {
      id: 7, card_id: 1, card_name: 'Cartão A', due_date: '2026-11-20', closing_date: '2026-11-12',
      statement_total_cents: null, paid_on: null, lines_total_cents: 50000, lines_count: 2,
    };
    const o = run([], { invoices: [inv] });
    expect(o.cash.pending_cents).toBe(50000);
    expect(o.cash.items[0]).toMatchObject({ kind: 'fatura', status: 'pending', estimated: true, date: '2026-11-20' });
    expect(o.forecast.has_estimates).toBe(true);
    const confirmed = run([], { invoices: [{ ...inv, statement_total_cents: 51234 }] });
    expect(confirmed.cash.items[0]).toMatchObject({ amount_cents: 51234, estimated: false });
  });

  it('fatura já paga não é contada de novo como pendente', () => {
    const inv: InvoiceRow = {
      id: 7, card_id: 1, card_name: 'Cartão A', due_date: '2026-11-05', closing_date: null,
      statement_total_cents: 40000, paid_on: '2026-11-05', lines_total_cents: 40000, lines_count: 1,
    };
    const pay = tx({ type: 'invoice_payment', total_cents: 40000, card_id: 1, invoice_id: 7 });
    const o = run([pay], { invoices: [inv] });
    expect(o.cash.total_cents).toBe(40000);
    expect(o.cash.items).toHaveLength(1);
  });
});

describe('despesas compartilhadas e reembolsos', () => {
  it('custo pessoal = minha parte; caixa = total pago pela conta', () => {
    const o = run([tx({ total_cents: 200000, my_share_cents: 128000 })]);
    expect(o.spending.realized_mine_cents).toBe(128000);
    expect(o.spending.realized_total_cents).toBe(200000);
    expect(o.cash.paid_cents).toBe(200000);
  });

  it('reembolso recebido é entrada de caixa, não receita, e não altera meu gasto', () => {
    const exp = tx({ id: 500, total_cents: 200000, my_share_cents: 128000 });
    const reimb = tx({ type: 'reimbursement', total_cents: 72000, reimbursement_for_id: 500 } as Partial<TxRow>);
    const o = run([exp, reimb], {
      reimbursements: [{ id: 500, description: 'Escola', month_ref: '2026-11', shared_with: null, others_cents: 72000, received_cents: 72000 }],
    });
    expect(o.income.net_cents).toBe(0);
    expect(o.spending.realized_mine_cents).toBe(128000);
    expect(o.reimbursements.received_in_month_cents).toBe(72000);
    expect(o.reimbursements.pending_all_cents).toBe(0);
    expect(o.forecast.month_result_cents).toBe(72000 - 200000);
  });

  it('reembolso pendente aparece separado e só entra no cenário "se todos reembolsarem"', () => {
    const exp = tx({ id: 501, total_cents: 200000, my_share_cents: 128000 });
    const o = run([exp], {
      reimbursements: [{ id: 501, description: 'Escola', month_ref: '2026-11', shared_with: 'Ana', others_cents: 72000, received_cents: 20000 }],
    });
    expect(o.reimbursements.pending_month_cents).toBe(52000);
    expect(o.forecast.month_result_cents).toBe(-200000);
    expect(o.forecast.month_result_with_reimbursements_cents).toBe(-200000 + 52000);
  });
});

describe('transferências próprias', () => {
  it('não são gasto, receita nem saída de caixa', () => {
    const o = run([tx({ type: 'transfer', total_cents: 500000, account_id: 1 })]);
    expect(o.spending.realized_mine_cents).toBe(0);
    expect(o.income.net_cents).toBe(0);
    expect(o.cash.total_cents).toBe(0);
    expect(o.forecast.month_result_cents).toBe(0);
  });
});

describe('cheque especial', () => {
  const accounts = [{ id: 1, name: 'Conta', balance_cents: -300000, balance_date: '2026-11-09', overdraft_limit_cents: 500000 }];
  it('saldo negativo é dívida; pagar a dívida não é despesa; juros e tarifas são', () => {
    const payment = tx({ type: 'overdraft_payment', total_cents: 100000 });
    const interest = tx({ total_cents: 4500, category_slug: 'juros-tarifas', category_name: 'Juros e tarifas' });
    const o = run([payment, interest], { accounts });
    expect(o.overdraft.debt_cents).toBe(300000);
    expect(o.overdraft.amortized_in_month_cents).toBe(100000);
    expect(o.overdraft.costs_in_month_cents).toBe(4500);
    expect(o.spending.realized_mine_cents).toBe(4500); // só os juros
  });
});

describe('salário', () => {
  it('separa bruto, descontos e líquido e sinaliza estimativa e data a confirmar', () => {
    const s1 = tx({ type: 'income', status: 'scheduled', gross_cents: 800000, deductions_cents: 120000, total_cents: 680000, is_estimate: true, date_confirmed: false, paid_on: null, occurred_on: null, due_date: null });
    const s2 = tx({ type: 'income', status: 'scheduled', gross_cents: 1000000, deductions_cents: 150000, total_cents: 850000, is_estimate: true, date_confirmed: false, paid_on: null, occurred_on: null, due_date: null });
    const o = run([s1, s2]);
    expect(o.income.gross_cents).toBe(1800000);
    expect(o.income.deductions_cents).toBe(270000); // imposto total estimado de R$ 2.700
    expect(o.income.net_cents).toBe(1530000);
    expect(o.forecast.has_estimates).toBe(true);
    expect(o.forecast.has_unconfirmed_dates).toBe(true);
    expect(o.attention.map((a) => a.code)).toEqual(expect.arrayContaining(['estimated', 'dates']));
  });
});

describe('previsão de saldo', () => {
  const accounts = [{ id: 1, name: 'Conta', balance_cents: 100000, balance_date: '2026-11-09', overdraft_limit_cents: null }];
  const pendingRent = tx({ status: 'scheduled', paid_on: null, due_date: '2026-11-15', total_cents: 180000, occurred_on: null });
  const salary = tx({ type: 'income', status: 'scheduled', paid_on: null, due_date: '2026-11-20', total_cents: 850000, occurred_on: null });

  it('saldo previsto = saldo informado + entradas pendentes − saídas pendentes (mês atual)', () => {
    const o = run([pendingRent, salary], { accounts });
    expect(o.forecast.projected_balance_cents).toBe(100000 + 850000 - 180000);
  });
  it('não inventa saldo: sem saldo informado não há previsão de saldo', () => {
    const o = run([pendingRent, salary]);
    expect(o.forecast.projected_balance_cents).toBeNull();
    expect(o.forecast.month_result_cents).toBe(850000 - 180000);
    expect(o.attention.some((a) => a.code === 'no_balance')).toBe(false); // sem contas cadastradas
    const withAcc = run([pendingRent], { accounts: [{ ...accounts[0], balance_cents: null, balance_date: null }] });
    expect(withAcc.forecast.projected_balance_cents).toBeNull();
    expect(withAcc.attention.some((a) => a.code === 'no_balance')).toBe(true);
  });
  it('em outro mês não projeta saldo, apenas o resultado do fluxo', () => {
    const o = run([pendingRent, salary], { accounts, today: '2026-10-10' });
    expect(o.forecast.projected_balance_cents).toBeNull();
  });
  it('itens pendentes sem data aparecem depois dos datados e como "data a confirmar"', () => {
    const undated = tx({ status: 'scheduled', paid_on: null, due_date: null, occurred_on: null, date_confirmed: false, total_cents: 5000 });
    const o = run([undated, pendingRent]);
    expect(o.upcoming.map((u) => u.date)).toEqual(['2026-11-15', null]);
    expect(o.upcoming[1].date_confirmed).toBe(false);
  });
});
