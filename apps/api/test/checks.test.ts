import { describe, expect, it } from 'vitest';
import { computeChecks, type CheckInput, type InvoiceCheckRow } from '../src/services/checks.js';
import { buildOutlookMonth, estimateInvoice, type InvoiceInfo } from '../src/services/outlook.js';

const TODAY = '2026-11-21';

const info = (over: Partial<InvoiceInfo> = {}): InvoiceInfo => ({
  invoice_id: 1, card_id: 1, card_name: 'Cartão A', due_date: '2026-12-09', closing_date: '2026-12-02',
  statement_total_cents: null, fixed_cents: 0, variable_cents: 100_000, lines_count: 5, last_purchase_on: '2026-11-20', ...over,
});

function base(over: Partial<CheckInput> = {}, invoices: InvoiceInfo[] = [info()], history: number[] = [100_000, 100_000, 100_000]): CheckInput {
  const outlook = buildOutlookMonth({
    month: '2026-12', today: TODAY, paid_cents: 0, cash_items: [],
    invoices: invoices.map((i) => estimateInvoice(i, history, TODAY)),
  });
  return {
    month: '2026-12', today: TODAY, outlook, invoices: [], overview_pending_cents: outlook.committed_cents,
    income_cents: 1_500_000, scheduled_income_cents: 0, uncategorized: { count: 0, total_cents: 0 }, duplicates: [], ...over,
  };
}
const inv = (over: Partial<InvoiceCheckRow> = {}): InvoiceCheckRow => ({
  id: 1, card_id: 1, card_name: 'Cartão A', due_date: '2026-12-09', statement_total_cents: null, paid_on: null,
  lines_total_cents: 100_000, lines_count: 5, ...over,
});
const codes = (i: CheckInput) => computeChecks(i).checks.map((c) => c.code);

describe('conferência dos números', () => {
  it('tudo certo: nenhum alerta e todas as verificações passam', () => {
    const r = computeChecks(base({ invoices: [inv()] }));
    expect(r.checks).toEqual([]);
    expect(r.passed).toBe(r.total);
  });

  it('total confirmado diferente da soma das compras é alerta vermelho, com o valor da diferença', () => {
    const r = computeChecks(base({ invoices: [inv({ statement_total_cents: 90_000, lines_total_cents: 100_000 })] }));
    expect(r.checks[0]).toMatchObject({ code: 'invoice_sum_mismatch', level: 'bad' });
    expect(r.checks[0].detail).toContain('R$ 100,00');
    // Diferença de 1 centavo é arredondamento: não alerta.
    expect(codes(base({ invoices: [inv({ statement_total_cents: 99_999, lines_total_cents: 100_000 })] }))).toEqual([]);
  });

  it('fatura negativa (pagamento entrou como compra) e fatura vencida sem pagamento', () => {
    expect(codes(base({ invoices: [inv({ lines_total_cents: -193_000 })] }))).toContain('invoice_negative');
    expect(codes(base({ invoices: [inv({ due_date: '2026-11-09' })] }))).toContain('invoice_overdue');
    expect(codes(base({ invoices: [inv({ due_date: '2026-11-09', paid_on: '2026-11-09' })] }))).not.toContain('invoice_overdue');
  });

  it('fatura bem acima do padrão do cartão (precisa de 2+ faturas de histórico)', () => {
    const high = info({ variable_cents: 400_000, last_purchase_on: '2026-11-20' });
    expect(codes(base({ invoices: [inv()] }, [high]))).toContain('invoice_outlier');
    // Com 1 só fatura de histórico não dá para dizer que é fora do padrão.
    expect(codes(base({ invoices: [inv()] }, [high], [100_000]))).not.toContain('invoice_outlier');
    // Diferença pequena em valor absoluto não alerta, mesmo sendo grande em %.
    const small = info({ variable_cents: 20_000 });
    expect(codes(base({ invoices: [inv()] }, [small], [10_000, 10_000, 10_000]))).not.toContain('invoice_outlier');
  });

  it('estimativa com pouco histórico e fatura desatualizada', () => {
    expect(codes(base({ invoices: [inv()] }, [info()], [100_000]))).toContain('thin_history');
    const stale = info({ last_purchase_on: '2026-11-10' });
    expect(codes(base({ invoices: [inv()] }, [stale]))).toContain('stale_invoices');
  });

  it('compras idênticas no mesmo dia viram aviso, com o quanto o custo estaria inflado', () => {
    const r = computeChecks(base({ invoices: [inv()], duplicates: [{ occurred_on: '2026-11-18', card_name: 'Cartão A', total_cents: 4_000, count: 3 }] }));
    const d = r.checks.find((c) => c.code === 'possible_duplicates')!;
    expect(d.level).toBe('warn');
    expect(d.detail).toContain('R$ 80,00'); // 2 cópias extras de R$ 40,00
  });

  it('previsão de caixa que não fecha com a visão do mês, mês sem receita e despesas sem categoria', () => {
    expect(codes(base({ invoices: [inv()], overview_pending_cents: 1 }))).toContain('outlook_mismatch');
    expect(codes(base({ invoices: [inv()], income_cents: 0, scheduled_income_cents: 0 }))).toContain('no_income');
    expect(codes(base({ invoices: [inv()], scheduled_income_cents: 100 , income_cents: 0 }))).not.toContain('no_income');
    expect(codes(base({ invoices: [inv()], uncategorized: { count: 2, total_cents: 5_000 } }))).toContain('uncategorized');
  });

  it('quando a maior parte é estimativa, informa quanto está lançado', () => {
    const r = computeChecks(base({ invoices: [inv()] }, [info({ variable_cents: 10_000 })], [100_000, 100_000, 100_000]));
    expect(r.certain_pct).toBeLessThan(70);
    expect(r.checks.map((c) => c.code)).toContain('mostly_estimate');
  });

  it('ordena do mais grave para o menos grave', () => {
    const r = computeChecks(base({
      invoices: [inv({ statement_total_cents: 1, lines_total_cents: 100_000 })],
      uncategorized: { count: 1, total_cents: 100 },
      income_cents: 0,
    }));
    expect(r.checks.map((c) => c.level)).toEqual([...r.checks.map((c) => c.level)].sort((a, b) => ['bad', 'warn', 'info'].indexOf(a) - ['bad', 'warn', 'info'].indexOf(b)));
    expect(r.checks[0].level).toBe('bad');
  });
});
