import { describe, expect, it } from 'vitest';
import { addMonths, clampedDate, normalizeText, parseDate, parseMoney } from '../src/lib.js';

describe('parseMoney', () => {
  it.each([
    ['R$ 1.234,56', 123456],
    ['1.234,56', 123456],
    ['-1.234,56', -123456],
    ['(84,24)', -8424],
    ['2085,65', 208565],
    ['1234.56', 123456],
    ['1,234.56', 123456],
    ['592,24 D', -59224],
    ['592,24 C', 59224],
    ['120', 12000],
    ['1.280', 128000],
    ['-R$ 10,00', -1000],
    ['10,00-', -1000],
  ])('%s → %i', (input, expected) => {
    expect(parseMoney(input)).toBe(expected);
  });
  it.each(['', 'abc', '12/11', '1,2,3', '--5'])('rejeita "%s"', (input) => {
    expect(parseMoney(input)).toBeNull();
  });
});

describe('parseDate', () => {
  it('formatos comuns', () => {
    expect(parseDate('16/12/2026')).toBe('2026-12-16');
    expect(parseDate('16/12/26')).toBe('2026-12-16');
    expect(parseDate('2026-12-16')).toBe('2026-12-16');
    expect(parseDate('05 NOV', 2026)).toBe('2026-11-05');
    expect(parseDate('05/11', 2026)).toBe('2026-11-05');
  });
  it('não inventa ano nem data inválida', () => {
    expect(parseDate('05/11')).toBeNull();
    expect(parseDate('31/02/2026')).toBeNull();
    expect(parseDate('texto')).toBeNull();
  });
});

describe('datas', () => {
  it('addMonths e clampedDate', () => {
    expect(addMonths('2026-11', 1)).toBe('2026-12');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
    expect(clampedDate(2027, 2, 31)).toBe('2027-02-28');
  });
  it('normalizeText', () => {
    expect(normalizeText('  PIX  Transferência ')).toBe('pix transferencia');
  });
});
