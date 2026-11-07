import { describe, expect, it } from 'vitest';
import { merchantKey, suggest, type LearnedRule } from '../src/importer/classify.js';

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
