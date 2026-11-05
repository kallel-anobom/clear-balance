import { describe, expect, it } from 'vitest';
import { invoiceDatesForDue, invoiceDatesForPurchase } from '../src/services/invoices.js';

describe('faturas de cartão', () => {
  const card = { closing_day: 25, due_day: 5 }; // fecha dia 25, vence dia 5 do mês seguinte
  it('compra antes do fechamento vai para a fatura que fecha no mês', () => {
    expect(invoiceDatesForPurchase(card, '2026-11-10')).toEqual({ closing_date: '2026-11-25', due_date: '2026-12-05' });
    expect(invoiceDatesForPurchase(card, '2026-11-25')).toEqual({ closing_date: '2026-11-25', due_date: '2026-12-05' });
  });
  it('compra depois do fechamento vai para a fatura seguinte', () => {
    expect(invoiceDatesForPurchase(card, '2026-11-26')).toEqual({ closing_date: '2026-12-25', due_date: '2027-01-05' });
    expect(invoiceDatesForPurchase(card, '2026-12-30')).toEqual({ closing_date: '2027-01-25', due_date: '2027-02-05' });
  });
  it('vencimento no mesmo mês do fechamento quando vence depois', () => {
    expect(invoiceDatesForPurchase({ closing_day: 3, due_day: 10 }, '2026-11-02')).toEqual({
      closing_date: '2026-11-03',
      due_date: '2026-11-10',
    });
  });
  it('deriva fechamento a partir do vencimento informado', () => {
    expect(invoiceDatesForDue(card, '2026-12-05')).toEqual({ closing_date: '2026-11-25', due_date: '2026-12-05' });
  });
});
