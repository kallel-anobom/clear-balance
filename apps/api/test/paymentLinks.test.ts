import { describe, expect, it } from 'vitest';
import { suggestPaymentLinks, type OpenInvoice, type UnlinkedPayment } from '../src/services/paymentLinks.js';

const inv = (id: number, card_id: number, card_name: string, due_date: string, amount_cents: number): OpenInvoice => ({ id, card_id, card_name, due_date, amount_cents });
const pay = (id: number, description: string, total_cents: number, paid_on: string | null, card_id: number | null = null): UnlinkedPayment => ({ id, description, total_cents, paid_on, card_id });

const INVOICES = [
  inv(1, 1, 'Nubank', '2026-11-09', 370_469),
  inv(2, 2, 'Itau Azul', '2026-11-09', 643_650),
  inv(3, 3, 'Santander Elite', '2026-11-02', 261_231),
  inv(4, 1, 'Nubank', '2026-12-09', 257_794),
  inv(5, 2, 'Itau Azul', '2026-12-09', 454_710),
];

describe('sugestão de vínculo de pagamento de fatura', () => {
  it('liga pelo valor igual e vencimento próximo, mesmo sem o cartão na descrição', () => {
    const r = suggestPaymentLinks([pay(10, 'PAGAMENTO CARTAO CREDITO BCE', 370_469, '2026-11-11')], INVOICES);
    expect(r.get(10)!.suggestion).toMatchObject({ invoice_id: 1, confidence: 'alta' });
  });

  it('usa o banco citado na descrição para escolher o cartão', () => {
    const r = suggestPaymentLinks([pay(11, 'Pagamento cartao credito bce Banco Santander (br)', 261_231, '2026-11-03')], INVOICES);
    expect(r.get(11)!.suggestion).toMatchObject({ invoice_id: 3 });
    // Só mostra faturas do Santander como opção.
    expect(r.get(11)!.candidate_invoice_ids).toEqual([3]);
  });

  it('não sugere quando o valor não bate (pagamento parcial), mas ordena as opções por proximidade', () => {
    const r = suggestPaymentLinks([pay(12, 'FATURA AZUL ITAU VS PLAT', 100_000, '2026-11-09')], INVOICES);
    expect(r.get(12)!.suggestion).toBeNull();
    expect(r.get(12)!.candidate_invoice_ids[0]).toBe(5); // 4.547,10 está mais perto de 1.000,00 que 6.436,50
    expect(r.get(12)!.candidate_invoice_ids).toContain(2);
  });

  it('valor até 2% diferente vira sugestão de confiança média', () => {
    const r = suggestPaymentLinks([pay(13, 'FATURA ITAU', 645_000, '2026-11-09')], INVOICES);
    expect(r.get(13)!.suggestion).toMatchObject({ invoice_id: 2, confidence: 'media' });
  });

  it('fatura de outro mês não é sugerida, e uma fatura não é sugerida para dois pagamentos', () => {
    const far = suggestPaymentLinks([pay(14, 'FATURA ITAU', 454_710, '2026-09-09')], INVOICES);
    expect(far.get(14)!.suggestion).toBeNull(); // vence em dezembro: longe demais
    const two = suggestPaymentLinks([pay(15, 'FATURA NUBANK', 370_469, '2026-11-09'), pay(16, 'FATURA NUBANK', 370_469, '2026-11-10')], INVOICES);
    const picked = [two.get(15)!.suggestion, two.get(16)!.suggestion].filter(Boolean);
    expect(picked).toHaveLength(1);
  });

  it('lançamento sem data ou sem cara de pagamento é marcado como suspeito e não recebe sugestão', () => {
    const r = suggestPaymentLinks([pay(17, 'Computador', 75_407, null), pay(18, 'Mercado', 370_469, '2026-11-09')], INVOICES);
    expect(r.get(17)).toMatchObject({ suspicious: true, suggestion: null });
    expect(r.get(18)).toMatchObject({ suspicious: true, suggestion: null });
  });
});
