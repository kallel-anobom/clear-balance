import { describe, expect, it, vi } from 'vitest';
import { compareCosts } from '../src/services/compare.js';
import { buildFacts, findInventedNumber, formatBRL, writeSummary, type SummaryInput } from '../src/services/summary.js';

const compare = compareCosts(
  { month: '2026-11', total_mine_cents: 150000, by_category: [{ category_id: 1, name: 'Mercado', used_cents: 90000 }, { category_id: 2, name: 'Lazer', used_cents: 60000 }] },
  [{ month: '2026-10', total_mine_cents: 100000, by_category: [{ category_id: 1, name: 'Mercado', used_cents: 60000 }, { category_id: 2, name: 'Lazer', used_cents: 40000 }] }],
);
const input: SummaryInput = {
  month: '2026-11',
  spending: {
    total_mine_cents: 150000, realized_mine_cents: 100000, planned_mine_cents: 50000,
    by_category: [
      { name: 'Mercado', used_cents: 90000, budget_cents: 80000, status: 'over' },
      { name: 'Lazer', used_cents: 60000, budget_cents: null, status: null },
    ],
    budget_summary: { count: 1, over_count: 1, near_count: 0 },
  },
  income: { net_cents: 500000 },
  forecast: { month_result_cents: -12345 },
  installments: { remaining_cents: 30000, remaining_count: 3 },
  compare,
  subscriptions: { count: 2, total_monthly_cents: 6000 },
};

describe('formatBRL', () => {
  it('formata como o usuário vê, sem espaço especial', () => {
    expect(formatBRL(123456)).toBe('R$ 1.234,56');
    expect(formatBRL(-5)).toBe('R$ 0,05');
    expect(formatBRL(100000000)).toBe('R$ 1.000.000,00');
  });
});

describe('fatos do resumo', () => {
  const set = buildFacts(input);
  const text = set.facts.map((f) => `${f.label}: ${f.value}`).join('\n');

  it('traz só agregados: categorias e totais, com sinal explícito no rótulo', () => {
    expect(text).toContain('Custo total do mês (minha parte): R$ 1.500,00');
    expect(text).toContain('Falta no mês (saídas maiores que entradas): R$ 123,45');
    expect(text).toContain('Orçamento de Mercado: situação: estourou o limite');
    expect(text).toContain('Este mês ficou acima da média em: R$ 500,00');
    expect(text).toContain('Diferença em relação à média: 50%');
    expect(text).not.toMatch(/-\s?R\$|−/); // nenhum valor negativo para a IA interpretar
  });

  it('só orçamentos fora do "ok" entram em detalhe', () => {
    const ok = buildFacts({ ...input, spending: { ...input.spending, by_category: [{ name: 'Mercado', used_cents: 100, budget_cents: 80000, status: 'ok' }] } });
    expect(ok.facts.some((f) => f.label.startsWith('Orçamento de Mercado'))).toBe(false);
  });

  it('sem comparação disponível, não inventa média', () => {
    const none = buildFacts({ ...input, compare: compareCosts({ month: '2026-11', total_mine_cents: 1, by_category: [] }, []) });
    expect(none.facts.some((f) => f.label.includes('Média'))).toBe(false);
  });
});

describe('conferência dos números do texto', () => {
  const { allowed } = buildFacts(input);
  it('aceita valores, percentuais e contagens que existem nos fatos', () => {
    expect(findInventedNumber('Você gastou R$ 1.500,00 em novembro de 2026, 50% acima da média de R$ 1.000,00.', allowed)).toBeNull();
    expect(findInventedNumber('São 2 assinaturas e 3 parcelas; o limite de 80% foi passado em 1 categoria.', allowed)).toBeNull();
    expect(findInventedNumber('Mercado pesa 60% do custo e custou R$ 900,00.', allowed)).toBeNull();
  });
  it('recusa valor, percentual ou número solto que não está nos fatos', () => {
    expect(findInventedNumber('Gastou R$ 1.499,99.', allowed)).toBe('R$ 1.499,99');
    expect(findInventedNumber('Subiu 51%.', allowed)).toBe('51%');
    expect(findInventedNumber('Foram 7 categorias.', allowed)).toBe('7');
    expect(findInventedNumber('Em 10/11 houve um gasto.', allowed)).not.toBeNull(); // datas não são permitidas
    expect(findInventedNumber('Gastou R$ 1,5 mil.', allowed)).not.toBeNull();
  });
});

describe('writeSummary', () => {
  const set = buildFacts(input);
  const reply = (i: unknown) => new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'registrar_resumo', input: i }], usage: { input_tokens: 5, output_tokens: 3 } }), { status: 200 });
  const opts = (f: unknown) => ({ apiKey: 'sk-test', model: 'm', fetchImpl: f as typeof fetch });

  it('sem chave não chama a rede', async () => {
    const f = vi.fn();
    await expect(writeSummary(set, { apiKey: undefined, model: 'm', fetchImpl: f as never })).rejects.toMatchObject({ code: 'no_key' });
    expect(f).not.toHaveBeenCalled();
  });

  it('devolve o texto validado e prende os dados em <dados>', async () => {
    const f = vi.fn(async () => reply({ resumo: 'Custo de R$ 1.500,00.', destaques: ['Mercado estourou.'], sugestoes: [] }));
    const r = await writeSummary(set, opts(f));
    expect(r.text.resumo).toContain('R$ 1.500,00');
    expect(r.usage).toEqual({ input_tokens: 5, output_tokens: 3 });
    const body = JSON.parse(((f.mock.calls[0] as unknown[])[1] as RequestInit).body as string);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'registrar_resumo' });
    expect(body.messages[0].content).toContain('<dados>');
  });

  it('descarta número inventado e formato inválido (listas grandes demais, texto vazio)', async () => {
    await expect(writeSummary(set, opts(async () => reply({ resumo: 'Gastou R$ 42,00.', destaques: [], sugestoes: [] })))).rejects.toMatchObject({ code: 'bad_output', status: 422 });
    await expect(writeSummary(set, opts(async () => reply({ resumo: 'ok', destaques: ['a', 'b', 'c', 'd', 'e'], sugestoes: [] })))).rejects.toMatchObject({ code: 'bad_output' });
    await expect(writeSummary(set, opts(async () => reply({ resumo: '', destaques: [], sugestoes: [] })))).rejects.toMatchObject({ code: 'bad_output' });
  });
});
