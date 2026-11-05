import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/importer/csv.js';
import { parseStatementText } from '../src/importer/pdf.js';
import { fingerprint, suggest } from '../src/importer/classify.js';

const buf = (s: string) => Buffer.from(s, 'utf8');

describe('CSV', () => {
  it('extrato de conta com ; e valores em formato brasileiro', () => {
    const csv = 'Data;Histórico;Valor\n03/11/2026;PIX ENVIADO MERCADO LIVRE;-1.234,56\n05/11/2026;SALARIO;8.000,00\n06/11/2026;SALDO DO DIA;\n';
    const r = parseCsv(buf(csv), { kind: 'account' });
    expect(r.needs_mapping).toBe(false);
    expect(r.rows).toEqual([
      { date: '2026-11-03', description: 'PIX ENVIADO MERCADO LIVRE', abs_cents: 123456, direction: 'out', uncertain_reason: null },
      { date: '2026-11-05', description: 'SALARIO', abs_cents: 800000, direction: 'in', uncertain_reason: null },
    ]);
    expect(r.skipped).toBe(1);
  });

  it('fatura de cartão: positivo é compra, negativo é crédito', () => {
    const csv = 'date,title,amount\n2026-11-02,Padaria,25.90\n2026-11-04,Pagamento recebido,-500.00\n';
    const r = parseCsv(buf(csv), { kind: 'card' });
    expect(r.rows.map((x) => [x.description, x.direction, x.abs_cents])).toEqual([
      ['Padaria', 'out', 2590],
      ['Pagamento recebido', 'in', 50000],
    ]);
    const inv = parseCsv(buf(csv), { kind: 'card', invertSign: true });
    expect(inv.rows[0].direction).toBe('in');
  });

  it('colunas separadas de crédito e débito e linhas de resumo antes do cabeçalho', () => {
    const csv = 'Extrato da conta\nPeríodo: novembro\nData;Descrição;Crédito;Débito\n01/11/2026;Depósito;100,00;\n02/11/2026;Tarifa;;12,50\n';
    const r = parseCsv(buf(csv), { kind: 'account' });
    expect(r.rows.map((x) => [x.direction, x.abs_cents])).toEqual([['in', 10000], ['out', 1250]]);
  });

  it('pede mapeamento quando não reconhece as colunas', () => {
    const r = parseCsv(buf('a;b;c\nx;y;z\n'), { kind: 'account' });
    expect(r.needs_mapping).toBe(true);
    expect(r.rows).toHaveLength(0);
  });

  it('aceita Latin-1', () => {
    const latin = Buffer.from('Data;Histórico;Valor\n03/11/2026;Farmácia;-10,00\n', 'latin1');
    expect(parseCsv(latin, { kind: 'account' }).rows[0].description).toBe('Farmácia');
  });
});

describe('PDF (texto extraído)', () => {
  const card = `FATURA CARTÃO
Vencimento 05/12/2026
05/11 MERCADO CENTRAL 120,50
10/11 UBER *TRIP 23,40
28/10 PARC LOJA X 02/03 56,10
Total da fatura 200,00
`;
  it('lê compras, ano pelo mês de referência e confere o total', () => {
    const r = parseStatementText(card, { kind: 'card', refMonth: '2026-11' });
    expect(r.rows.map((x) => [x.date, x.abs_cents])).toEqual([
      ['2026-11-05', 12050],
      ['2026-11-10', 2340],
      ['2026-10-28', 5610],
    ]);
    expect(r.detected_total_cents).toBe(20000);
    expect(r.detected_due_date).toBe('2026-12-05');
    expect(r.reconciliation_cents).toBe(0);
    expect(r.confidence).toBe('ok');
  });

  it('compra de dezembro numa fatura de janeiro fica no ano anterior', () => {
    const r = parseStatementText('30/12 LOJA 10,00\n', { kind: 'card', refMonth: '2027-01' });
    expect(r.rows[0].date).toBe('2026-12-30');
  });

  it('baixa confiança quando o total não bate', () => {
    const r = parseStatementText(card.replace('200,00', '999,00'), { kind: 'card', refMonth: '2026-11' });
    expect(r.confidence).toBe('low');
    expect(r.reconciliation_cents).toBe(79900);
  });

  it('extrato sem sinal: direção desconhecida exige revisão manual', () => {
    const r = parseStatementText('05/11/2026 PIX FULANO 50,00\n06/11/2026 SALDO DO DIA 1.000,00\n', { kind: 'account', refMonth: '2026-11' });
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].direction).toBeNull();
    expect(r.rows[0].uncertain_reason).toMatch(/entrada ou saída/);
  });

  it('com sinal explícito (C/D) a direção é conhecida', () => {
    const r = parseStatementText('05/11/2026 PIX 50,00 D\n06/11/2026 DEPOSITO 70,00 C\n', { kind: 'account', refMonth: '2026-11' });
    expect(r.rows.map((x) => x.direction)).toEqual(['out', 'in']);
  });

  it('não inventa nada quando não reconhece lançamentos', () => {
    const r = parseStatementText('Texto sem tabela\nOutra linha\n', { kind: 'account', refMonth: '2026-11' });
    expect(r.rows).toHaveLength(0);
    expect(r.confidence).toBe('none');
  });
});

describe('classificação', () => {
  const own = ['Fulano de Tal'];
  const s = (description: string, direction: 'in' | 'out', kind: 'account' | 'card' = 'account') =>
    suggest({ description, direction, kind, ownNames: own });

  it('PIX para Fulano de Tal é transferência própria', () => {
    expect(s('PIX ENVIADO FULANO DE TAL', 'out').type).toBe('transfer');
    expect(s('Pix recebido - FULANO DE TAL', 'in').type).toBe('transfer');
  });
  it('pagamento de fatura na conta não é despesa', () => {
    expect(s('PAGAMENTO FATURA CARTAO', 'out').type).toBe('invoice_payment');
  });
  it('pagamento recebido dentro da fatura é ignorado por padrão', () => {
    expect(s('Pagamento recebido', 'in', 'card').skip_by_default).toBe(true);
  });
  it('juros do cheque especial são despesa; pagamento do cheque especial não', () => {
    expect(s('JUROS LIMITE DA CONTA', 'out')).toMatchObject({ type: 'expense', category_slug: 'juros-tarifas' });
    expect(s('PAGAMENTO CHEQUE ESPECIAL', 'out').type).toBe('overdraft_payment');
  });
  it('fingerprint estável e sensível a ocorrência', () => {
    const a = fingerprint('acc:1', '2026-11-03', 1000, 'Café  Central', 0);
    expect(fingerprint('acc:1', '2026-11-03', 1000, 'cafe central', 0)).toBe(a);
    expect(fingerprint('acc:1', '2026-11-03', 1000, 'cafe central', 1)).not.toBe(a);
  });
});
