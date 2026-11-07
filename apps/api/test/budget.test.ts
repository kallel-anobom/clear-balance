import { describe, expect, it } from 'vitest';
import { compareCosts, previousMonths, type MonthCost } from '../src/services/compare.js';
import { budgetStatus, computeOverview, type TxRow } from '../src/services/overview.js';
import { detectSubscriptions, type SubTx } from '../src/services/subscriptions.js';

describe('status do orçamento', () => {
  it('ok até 80%, perto de 80% a 100%, estourou acima de 100%', () => {
    expect(budgetStatus(7999, 10000)).toBe('ok');
    expect(budgetStatus(8000, 10000)).toBe('near');
    expect(budgetStatus(10000, 10000)).toBe('near');
    expect(budgetStatus(10001, 10000)).toBe('over');
  });

  let seq = 0;
  const tx = (p: Partial<TxRow>): TxRow => ({
    id: ++seq, type: 'expense', description: 'x', category_id: 1, category_name: 'Mercado', category_slug: 'mercado',
    account_id: 1, card_id: null, invoice_id: null, status: 'paid', month_ref: '2026-11', occurred_on: '2026-11-05',
    due_date: null, paid_on: '2026-11-05', date_confirmed: true, total_cents: 10000, my_share_cents: null,
    gross_cents: null, deductions_cents: null, is_estimate: false, needs_review: false, review_note: null, ...p,
  });
  const run = (txs: TxRow[], budgets: { category_id: number; category_name: string; limit_cents: number }[]) =>
    computeOverview({ month: '2026-11', today: '2026-11-10', txs, invoices: [], accounts: [], reimbursements: [], yearlyWithoutMonth: [], budgets });

  it('usa minha parte, soma pagos e previstos e mostra categoria com teto mesmo sem gasto', () => {
    const o = run(
      [
        tx({ total_cents: 9000 }),
        tx({ total_cents: 4000, my_share_cents: 2000, status: 'scheduled', paid_on: null }),
        tx({ category_id: 2, category_name: 'Lazer', category_slug: 'lazer', total_cents: 1000 }),
      ],
      [
        { category_id: 1, category_name: 'Mercado', limit_cents: 10000 },
        { category_id: 3, category_name: 'Saúde', limit_cents: 50000 },
      ],
    );
    const by = Object.fromEntries(o.spending.by_category.map((c) => [c.name, c]));
    expect(by['Mercado']).toMatchObject({ used_cents: 11000, budget_cents: 10000, remaining_cents: -1000, status: 'over' });
    expect(by['Saúde']).toMatchObject({ used_cents: 0, budget_cents: 50000, status: 'ok' });
    expect(by['Lazer']).toMatchObject({ budget_cents: null, status: null });
    expect(o.spending.budget_summary).toMatchObject({ count: 2, total_limit_cents: 60000, total_used_cents: 11000, over_count: 1, near_count: 0 });
  });
});

describe('comparação com meses anteriores', () => {
  const m = (month: string, total: number, cats: [string, number][]): MonthCost => ({
    month, total_mine_cents: total, by_category: cats.map(([name, used_cents], i) => ({ category_id: i + 1, name, used_cents })),
  });

  it('lista os 3 meses anteriores', () => {
    expect(previousMonths('2026-02')).toEqual(['2026-01', '2025-12', '2025-11']);
  });

  it('compara com a média e destaca os maiores aumentos', () => {
    const r = compareCosts(
      m('2026-11', 150000, [['Mercado', 60000], ['Lazer', 30000], ['Casa', 60000]]),
      [
        m('2026-10', 100000, [['Mercado', 50000], ['Lazer', 10000], ['Casa', 40000]]),
        m('2026-09', 100000, [['Mercado', 50000], ['Lazer', 10000], ['Casa', 40000]]),
        m('2026-08', 100000, [['Mercado', 50000], ['Lazer', 10000], ['Casa', 40000]]),
      ],
    );
    expect(r).toMatchObject({ available: true, partial: false, avg_cents: 100000, diff_cents: 50000, diff_pct: 50 });
    expect(r.categories[0]).toMatchObject({ name: 'Lazer', diff_cents: 20000, diff_pct: 200 });
    expect(r.top_increases.map((c) => c.name)).toEqual(['Lazer', 'Casa', 'Mercado']);
  });

  it('mês anterior sem gastos não entra na média e avisa que é parcial; sem nenhum, não há comparação', () => {
    const cur = m('2026-11', 90000, [['Mercado', 90000]]);
    const r = compareCosts(cur, [m('2026-10', 60000, [['Mercado', 60000]]), m('2026-09', 0, []), m('2026-08', 0, [])]);
    expect(r).toMatchObject({ available: true, partial: true, months_used: ['2026-10'], avg_cents: 60000 });
    const none = compareCosts(cur, [m('2026-10', 0, []), m('2026-09', 0, []), m('2026-08', 0, [])]);
    expect(none).toMatchObject({ available: false, categories: [], diff_pct: null });
  });

  it('categoria nova (sem média) tem variação em valor, mas sem percentual', () => {
    const r = compareCosts(m('2026-11', 30000, [['Viagem', 30000]]), [m('2026-10', 10000, [['Mercado', 10000]])]);
    expect(r.categories.find((c) => c.name === 'Viagem')).toMatchObject({ avg_cents: 0, diff_cents: 30000, diff_pct: null });
  });
});

describe('detecção de assinaturas', () => {
  let seq = 0;
  const t = (description: string, month: string, cents: number, extra: Partial<SubTx> = {}): SubTx => ({
    id: ++seq, description, total_cents: cents, my_share_cents: null, month_ref: month, occurred_on: `${month}-15`, paid_on: null,
    category_id: 7, account_id: null, ...extra,
  });
  const opts = { currentMonth: '2026-11', recurringDescriptions: [] as string[] };

  it('acha o mesmo estabelecimento, valor parecido, 3+ meses seguidos e ainda ativo', () => {
    const subs = detectSubscriptions(
      [t('NETFLIX.COM 1234', '2026-09', 3990), t('NETFLIX.COM 5678', '2026-10', 3990), t('NETFLIX.COM 9999', '2026-11', 4490)],
      opts,
    );
    expect(subs).toHaveLength(1);
    expect(subs[0]).toMatchObject({
      months_count: 3, last_month: '2026-11', last_cents: 4490, price_change_cents: 500, typical_cents: 3990,
      draft: { total_cents: 4490, day_of_month: 15, category_id: 7 },
    });
    expect(subs[0].price_change_pct).toBeCloseTo(12.5, 1);
    expect(subs[0].yearly_estimate_cents).toBe(3990 * 12);
  });

  it('não é assinatura: poucos meses, meses com buracos, cancelada, várias no mesmo mês ou valores diferentes', () => {
    const subs = detectSubscriptions(
      [
        t('SPOTIFY', '2026-10', 2190), t('SPOTIFY', '2026-11', 2190), // só 2 meses
        t('GYM', '2026-06', 9000), t('GYM', '2026-08', 9000), t('GYM', '2026-10', 9000), // buracos
        t('VELHA ASSINATURA', '2026-05', 1000), t('VELHA ASSINATURA', '2026-06', 1000), t('VELHA ASSINATURA', '2026-07', 1000), // cancelada
        ...['2026-09', '2026-10', '2026-11'].flatMap((m) => [t('UBER TRIP', m, 2000), t('UBER TRIP', m, 2100)]), // várias por mês
        t('PADARIA BOA', '2026-09', 1500), t('PADARIA BOA', '2026-10', 4500), t('PADARIA BOA', '2026-11', 9000), // valores diferentes
      ],
      opts,
    );
    expect(subs).toEqual([]);
  });

  it('ignora parcelas, previstos, lançamentos de recorrência e quem já tem recorrência cadastrada', () => {
    const months = ['2026-09', '2026-10', '2026-11'];
    const base = [
      ...months.map((m) => t('LOJA PARCELADA', m, 5000, { installment_group: 'g1' })),
      ...months.map((m) => t('ACADEMIA X', m, 9000, { recurring_id: 3 })),
      ...months.map((m) => t('STREAMING Y', m, 3000, { is_projected: true })),
      ...months.map((m) => t('CLUBE ZETA', m, 7000)),
    ];
    expect(detectSubscriptions(base, opts).map((s) => s.merchant)).toEqual(['clube zeta']);
    expect(detectSubscriptions(base, { ...opts, recurringDescriptions: ['Clube Zeta mensalidade'] })).toEqual([]);
  });

  it('usa minha parte quando o gasto é dividido', () => {
    const subs = detectSubscriptions(['2026-09', '2026-10', '2026-11'].map((m) => t('PLANO FAMILIA', m, 8000, { my_share_cents: 4000 })), opts);
    expect(subs[0]).toMatchObject({ typical_cents: 4000 });
  });
});
