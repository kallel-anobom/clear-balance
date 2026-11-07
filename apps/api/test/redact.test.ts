import { describe, expect, it } from 'vitest';
import { redact } from '../src/importer/redact.js';

describe('redact', () => {
  it('troca CPF, CNPJ, e-mail e telefone', () => {
    const out = redact('Titular 123.456.789-01 CNPJ 12.345.678/0001-95 eu@exemplo.com tel (11) 91234-5678 +55 11 3456-7890');
    expect(out).toContain('[CPF]');
    expect(out).toContain('[CNPJ]');
    expect(out).toContain('[EMAIL]');
    expect(out.match(/\[TEL\]/g)).toHaveLength(2);
    expect(out).not.toMatch(/123\.456|12\.345|exemplo|91234|3456-7890/);
  });

  it('troca cartão, agência/conta e números longos', () => {
    const out = redact('Cartão 1234 5678 9012 3456 ag 1234 cc 12345-6 protocolo 202611050001234 conta: 987654-3');
    expect(out).toContain('[CARTAO]');
    expect(out).not.toMatch(/1234 5678|12345-6|202611050001234|987654/);
    expect(out).toContain('ag [CONTA]');
  });

  it('mantém valores em reais, datas e nomes de estabelecimentos', () => {
    const line = '05/11/2026 MERCADO CENTRAL R$ 1.234,56 - 12,30 (parc 02/10) 05 NOV 2026-11-05 **** 4321';
    expect(redact(line)).toBe(line);
    expect(redact('123.456.789,01')).toBe('123.456.789,01');
  });
});
