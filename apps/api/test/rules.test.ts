import { describe, expect, it } from 'vitest';
import { categoryFromRules, findSimilar, merchantKey, suggest, type LearnedRule } from '../src/importer/classify.js';

const rule = (p: Partial<LearnedRule>): LearnedRule => ({
  id: 1, kind: 'card', pattern: 'academia boa forma', category_id: 7, type: 'expense', ignore: false, use_count: 3, ...p,
});
const base = { direction: 'out' as const, ownNames: [] as string[] };

describe('merchantKey', () => {
  it('tira acentos, números, códigos, parcelas e símbolos', () => {
    expect(merchantKey('UBER *TRIP 1234 SAO PAULO BR')).toBe('uber trip sao');
    expect(merchantKey('Padaria do Zé PARC 02/10')).toBe('padaria ze');
    expect(merchantKey('Café São João - 12/11 R$ 45,90')).toBe('cafe sao joao');
  });
  it('é igual para a mesma loja com códigos diferentes', () => {
    expect(merchantKey('ACADEMIA BOA FORMA 0042')).toBe(merchantKey('Academia Boa Forma 7781'));
  });
  it('não aprende quando não sobra nome confiável', () => {
    expect(merchantKey('12/11 1234 98')).toBe('');
    expect(merchantKey('PIX 123')).toBe('');
    expect(merchantKey('PIX ENVIADO Maria Souza')).toBe('maria souza');
  });
  it('nunca inclui dígitos', () => {
    expect(merchantKey('LOJA X9 2026-11-05 R$ 80,00 TOTAL')).not.toMatch(/\d/);
  });
});

describe('suggest com regras aprendidas', () => {
  it('a regra vence as palavras-chave e marca a sugestão como aprendida', () => {
    const s = suggest({ ...base, kind: 'card', description: 'ACADEMIA BOA FORMA 0042', rules: [rule({})] });
    expect(s).toMatchObject({ type: 'expense', category_id: 7, learned: { id: 1, uses: 3 } });
    expect(s.note).toContain('aprendida');
    // Sem a regra, nada seria sugerido.
    expect(suggest({ ...base, kind: 'card', description: 'ACADEMIA BOA FORMA 0042' }).category_id).toBeUndefined();
  });

  it('a regra é separada por conta/cartão e só vale para o mesmo estabelecimento', () => {
    expect(suggest({ ...base, kind: 'account', description: 'ACADEMIA BOA FORMA', rules: [rule({})] }).learned ?? null).toBeNull();
    expect(suggest({ ...base, kind: 'card', description: 'ACADEMIA OUTRA', rules: [rule({})] }).learned ?? null).toBeNull();
  });

  it('o tipo aprendido não vale onde não faz sentido (entrada não vira pagamento de fatura)', () => {
    const r = rule({ kind: 'account', type: 'invoice_payment', category_id: null, pattern: 'banco xp' });
    const out = suggest({ ...base, kind: 'account', description: 'BANCO XP', rules: [r] });
    expect(out.type).toBe('invoice_payment');
    const inn = suggest({ ...base, direction: 'in', kind: 'account', description: 'BANCO XP', rules: [r] });
    expect(inn.type).not.toBe('invoice_payment');
  });

  it('regra de ignorar deixa a linha desmarcada; a mais específica vence', () => {
    const ign = suggest({ ...base, kind: 'card', description: 'ACADEMIA BOA FORMA', rules: [rule({ ignore: true })] });
    expect(ign.skip_by_default).toBe(true);
    const rules = [rule({ id: 1, pattern: 'academia', category_id: 1 }), rule({ id: 2, pattern: 'academia boa forma', category_id: 2 })];
    expect(suggest({ ...base, kind: 'card', description: 'ACADEMIA BOA FORMA 12', rules }).category_id).toBe(2);
  });
});

describe('semelhança de nomes', () => {
  const R = (id: number, pattern: string, category_id: number | null, kind: 'account' | 'card' = 'account', use_count = 1): LearnedRule => ({
    id, kind, pattern, category_id, type: 'expense', ignore: false, use_count,
  });

  it('sozinha, uma palavra em comum não basta; duas regras da mesma categoria formam uma "palavra de categoria"', () => {
    expect(findSimilar('Padaria Pão Quente', 'account', [R(1, 'padaria ze', 7)])).toBeNull();
    const two = findSimilar('Padaria Pão Quente', 'account', [R(1, 'padaria ze', 7), R(2, 'padaria sol', 7)]);
    expect(two).toMatchObject({ category_id: 7, pattern: 'padaria' });
  });

  it('categorias diferentes para a mesma palavra cancelam a sugestão (não chuta)', () => {
    expect(findSimilar('Banco Novo', 'account', [R(1, 'banco itau', 7), R(2, 'banco bradesco', 9)])).toBeNull();
    expect(findSimilar('Banco Itau', 'account', [R(1, 'banco bradesco', 9)])).toBeNull();
  });

  it('cobertura alta com uma regra, e tolera erro de digitação', () => {
    expect(findSimilar('Uber Trip', 'account', [R(1, 'uber trip sao', 4)])).toMatchObject({ category_id: 4, score: 1 });
    expect(findSimilar('Starbuks Coffee', 'account', [R(1, 'starbucks', 7)])).toMatchObject({ category_id: 7 });
    expect(findSimilar('Uber Eats', 'account', [R(1, 'uber trip', 4)])).toBeNull(); // 1 de 2 palavras: abaixo do limiar
  });

  it('palavras genéricas não identificam estabelecimento; regras sem categoria e de outro tipo de alvo são ignoradas', () => {
    expect(findSimilar('Loja Nova', 'account', [R(1, 'loja nova centro', 7)])).toBeNull();
    expect(findSimilar('Uber Trip', 'account', [R(1, 'uber trip sao', null)])).toBeNull();
    expect(findSimilar('Uber Trip', 'account', [R(1, 'uber trip sao', 4, 'card')])).toBeNull();
  });

  it('suggest() devolve o parecido sem tratá-lo como regra exata; exata vence', () => {
    const rules = [R(1, 'uber trip sao', 4)];
    const s = suggest({ ...base, kind: 'account', description: 'UBER TRIP 99', rules });
    expect(s.learned).toBeUndefined();
    expect(s.category_id).toBeUndefined();
    expect(s.similar).toMatchObject({ category_id: 4 });
    const exact = suggest({ ...base, kind: 'account', description: 'UBER TRIP SAO', rules });
    expect(exact.learned).toMatchObject({ id: 1 });
    expect(exact.similar).toBeUndefined();
  });

  it('categoryFromRules: exata, parecida ou nada; regra exata sem categoria não cai em parecida', () => {
    expect(categoryFromRules('UBER TRIP SAO', 'account', [R(1, 'uber trip sao', 4)])).toMatchObject({ via: 'exact', category_id: 4 });
    expect(categoryFromRules('UBER TRIP', 'account', [R(1, 'uber trip sao', 4)])).toMatchObject({ via: 'similar' });
    expect(categoryFromRules('UBER TRIP SAO', 'account', [R(1, 'uber trip sao', null), R(2, 'uber trip', 4)])).toBeNull();
  });
});
