import { describe, expect, it } from 'vitest';
import { detectInstallment, installmentGroup } from '../src/importer/installments.js';
import { cleanOcrText, parseStatementText } from '../src/importer/pdf.js';
import { dateInInvoiceCycle } from '../src/services/installments.js';

describe('detectInstallment', () => {
  it.each([
    ['MAGAZINE LUIZA PARC 02/10', 2, 10, 'MAGAZINE LUIZA'],
    ['AMAZON PARCELA 3 DE 6', 3, 6, 'AMAZON'],
    ['Loja X - Parcela 1/12', 1, 12, 'Loja X'],
    ['LOJA XYZ PARC.04/05', 4, 5, 'LOJA XYZ'],
    ['FARMACIA SAO JOAO PARC 10/10', 10, 10, 'FARMACIA SAO JOAO'],
  ])('reconhece "%s"', (desc, no, total, base) => {
    expect(detectInstallment(desc)).toMatchObject({ no, total, base, bare: false });
  });

  it('aceita "03/10" solto só no fim, marcando como incerto', () => {
    expect(detectInstallment('RIACHUELO 03/10')).toMatchObject({ no: 3, total: 10, base: 'RIACHUELO', bare: true });
  });

  it.each([
    'MERCADO CENTRAL',
    'COMPRA 12/03/2026 LOJA',
    'LOJA 12/03', // 12 de 3: parcela maior que o total, provavelmente uma data
    'LOJA PARC 5/3',
    'LOJA PARC 1/1',
    'IFOOD *PEDIDO 10/2 TESTE',
    'PARC 02/10',
  ])('ignora "%s"', (desc) => {
    expect(detectInstallment(desc)).toBeNull();
  });

  it('a mesma compra gera o mesmo grupo em todas as parcelas, mesmo com texto diferente', () => {
    const a = detectInstallment('MAGAZINE LUIZA PARC 02/10')!;
    const b = detectInstallment('Magazine Luiza - parcela 3/10')!;
    expect(installmentGroup(1, a.base, a.total)).toBe(installmentGroup(1, b.base, b.total));
    expect(installmentGroup(2, a.base, a.total)).not.toBe(installmentGroup(1, a.base, a.total));
    expect(installmentGroup(1, a.base, 12)).not.toBe(installmentGroup(1, a.base, 10));
  });

  it('a descrição das parcelas projetadas volta ao mesmo grupo', () => {
    const real = detectInstallment('MAGAZINE LUIZA PARC 02/10')!;
    const projected = detectInstallment(`${real.base} - parcela 3/10`)!;
    expect(projected.base).toBe(real.base);
  });
});

describe('dateInInvoiceCycle', () => {
  const card = { closing_day: 25, due_day: 5 };
  it('mantém a data se estiver no ciclo da fatura', () => {
    expect(dateInInvoiceCycle(card, '2026-11-25', '2026-10-26')).toBe('2026-10-26');
    expect(dateInInvoiceCycle(card, '2026-11-25', '2026-11-25')).toBe('2026-11-25');
  });
  it('usa a data de fechamento quando a parcela traz a data da compra original', () => {
    expect(dateInInvoiceCycle(card, '2026-11-25', '2026-08-12')).toBe('2026-11-25');
    expect(dateInInvoiceCycle(card, '2026-11-25', '2026-10-25')).toBe('2026-11-25');
  });
  it('sem data de fechamento, não altera', () => {
    expect(dateInInvoiceCycle(card, null, '2026-08-12')).toBe('2026-08-12');
  });
});

describe('OCR', () => {
  it('corrige espaços perdidos em valores e datas', () => {
    expect(cleanOcrText('12 / 03 LOJA 1.234 ,56')).toBe('12/03 LOJA 1.234,56');
    expect(cleanOcrText('05/11 MERCADO 59, 90')).toBe('05/11 MERCADO 59,90');
    expect(cleanOcrText('R $ 10,00')).toBe('R$ 10,00');
  });

  it('texto de imagem nunca passa de confiança "baixa" e avisa o usuário', () => {
    const text = '04/10 MAGAZINE LUIZA PARC 02/04 150,00\n10/10 PADARIA 30,00';
    const normal = parseStatementText(text, { kind: 'card', refMonth: '2026-10' });
    expect(normal.confidence).toBe('ok');
    const ocr = parseStatementText(text, { kind: 'card', refMonth: '2026-10', ocr: true });
    expect(ocr.rows).toHaveLength(2);
    expect(ocr.confidence).toBe('low');
    expect(ocr.warnings[0]).toMatch(/OCR/);
  });

  it('OCR com espaço antes da vírgula ainda lê o valor', () => {
    const r = parseStatementText('04/10 LOJA 1.234 ,56', { kind: 'card', refMonth: '2026-10', ocr: true });
    expect(r.rows[0].abs_cents).toBe(123456);
  });
});
