import { describe, expect, it } from 'vitest';
import { parseLayoutLines } from '../src/importer/layout.js';
import { parseStatementText } from '../src/importer/pdf.js';

// Amostras SINTÉTICAS de como apps de banco costumam aparecer em prints (nenhum dado real).
const lines = (s: string) => s.trim().split('\n');
const account = { kind: 'account' as const, refMonth: '2026-11', today: '2026-11-06' };
const card = { kind: 'card' as const, refMonth: '2026-11', today: '2026-11-06' };

describe('leitor flexível (formato de app de banco)', () => {
  it('data como título do grupo, descrição acima do valor, sinais "- R$" e "+ R$"', () => {
    const r = parseLayoutLines(
      lines(`
Extrato
05 NOV
Mercado Central
- R$ 120,50
Pix recebido
Maria Silva
+ R$ 300,00
04 NOV 2026
Padaria do Zé
R$ 15,00
`),
      account,
    );
    expect(r.mode).toBe('desc-first');
    expect(r.rows).toHaveLength(3);
    expect(r.rows[0]).toMatchObject({ date: '2026-11-05', description: 'Mercado Central', abs_cents: 12050, direction: 'out' });
    expect(r.rows[1]).toMatchObject({ date: '2026-11-05', description: 'Pix recebido Maria Silva', abs_cents: 30000, direction: 'in' });
    // Valor sem sinal e sem pista no texto: direção desconhecida, o usuário escolhe.
    expect(r.rows[2]).toMatchObject({ date: '2026-11-04', description: 'Padaria do Zé', direction: null });
    expect(r.rows[2].uncertain_reason).toMatch(/entrada ou saída/);
  });

  it('valor acima da descrição e datas "Hoje" / "Ontem"', () => {
    const r = parseLayoutLines(
      lines(`
Hoje
R$ 45,90
Uber Trip
Ontem
R$ 200,00
Restaurante Sabor
`),
      card,
    );
    expect(r.mode).toBe('amount-first');
    expect(r.relativeDates).toBe(true);
    expect(r.rows.map((x) => [x.date, x.description, x.abs_cents, x.direction])).toEqual([
      ['2026-11-06', 'Uber Trip', 4590, 'out'],
      ['2026-11-05', 'Restaurante Sabor', 20000, 'out'],
    ]);
  });

  it('cabeçalho com dia da semana, data por extenso e linha única "descrição  valor"', () => {
    const r = parseLayoutLines(
      lines(`
Seg, 5 de novembro de 2026
Farmácia Popular -R$ 32,10
terça-feira, 06/11
Salário empresa R$ 8.000,00 C
`),
      account,
    );
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ date: '2026-11-05', description: 'Farmácia Popular', abs_cents: 3210, direction: 'out' });
    expect(r.rows[1]).toMatchObject({ date: '2026-11-06', abs_cents: 800000, direction: 'in' });
  });

  it('deduz entrada/saída pelo texto só como sugestão marcada para conferir', () => {
    const r = parseLayoutLines(lines('05 NOV\nPix enviado Loja X\nR$ 50,00\nPix recebido João\nR$ 70,00'), account);
    expect(r.rows[0]).toMatchObject({ direction: 'out' });
    expect(r.rows[0].uncertain_reason).toMatch(/deduzida/);
    expect(r.rows[1]).toMatchObject({ direction: 'in' });
  });

  it('ignora linhas de saldo/total, horários e rótulos de interface', () => {
    const r = parseLayoutLines(
      lines(`
05 NOV
Saldo do dia
R$ 1.000,00
14:32
Compra no débito
Mercado
- R$ 10,00
`),
      account,
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ description: 'Mercado', abs_cents: 1000 });
  });

  it('sem data no documento: a linha existe, mas sem data e marcada para informar', () => {
    const r = parseLayoutLines(lines('Mercado\n- R$ 10,00'), account);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].date).toBeNull();
    expect(r.rows[0].uncertain_reason).toMatch(/sem data/);
  });

  it('data sem ano em mês posterior ao de referência é do ano anterior (compra de dezembro em fatura de janeiro)', () => {
    const r = parseLayoutLines(lines('28 DEZ\nLoja\nR$ 10,00'), { ...card, refMonth: '2027-01' });
    expect(r.rows[0].date).toBe('2026-12-28');
    expect(r.yearless).toBe(true);
  });
});

describe('parseStatementText usa o leitor flexível só quando o clássico não entende', () => {
  it('print de app: cai no formato flexível, confiança baixa e aviso claro', () => {
    const p = parseStatementText('05 NOV\nMercado\n- R$ 10,00\n06 NOV\nPadaria\n- R$ 5,00', {
      kind: 'account', refMonth: '2026-11', ocr: true, today: '2026-11-06',
    });
    expect(p.rows).toHaveLength(2);
    expect(p.confidence).toBe('low');
    expect(p.warnings.join(' ')).toMatch(/Formato de app reconhecido/);
  });

  it('extrato clássico (data no começo da linha) continua pelo caminho clássico', () => {
    const p = parseStatementText('05/11/2026 MERCADO -12,30\n06/11/2026 PADARIA -5,00', {
      kind: 'account', refMonth: '2026-11', today: '2026-11-06',
    });
    expect(p.rows).toHaveLength(2);
    expect(p.confidence).toBe('ok');
    expect(p.warnings.join(' ')).not.toMatch(/Formato de app/);
  });

  it('texto sem nada reconhecível continua sendo "nenhum lançamento"', () => {
    const p = parseStatementText('Olá\nBem-vindo ao app', { kind: 'account', refMonth: '2026-11' });
    expect(p.rows).toHaveLength(0);
    expect(p.confidence).toBe('none');
  });
});
