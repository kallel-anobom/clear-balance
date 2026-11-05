import { createHash } from 'node:crypto';
import { normalizeText } from '../lib.js';
import type { TargetKind } from './types.js';

export type SuggestedType = 'income' | 'expense' | 'transfer' | 'reimbursement' | 'invoice_payment' | 'overdraft_payment';

export interface Suggestion {
  type: SuggestedType;
  category_slug: string | null;
  /** Por padrão, a linha não deve ser importada (ex.: pagamento de fatura dentro da própria fatura). */
  skip_by_default: boolean;
  needs_review: boolean;
  note: string | null;
}

const OVERDRAFT_PAYMENT = /\b(pagamento|pgto|pag|amortizacao|cobertura|quitacao)\b.*\b(cheque especial|limite|lis)\b/;
const OVERDRAFT_COST = /cheque especial|juros (limite|cheque|cred|conta)|\blis\b|encargos|\biof\b|tarifa|\btar\b|anuidade/;
const INVOICE_PAYMENT_ACCOUNT = /(pagamento|pgto|pag)\b.*\b(fatura|cartao)|fatura (do )?cartao|\bfatura\b/;
const INVOICE_PAYMENT_ON_CARD = /pagamento (recebido|efetuado|de fatura|fatura|em)|pgto (fatura|recebido)|credito de pagamento|obrigado pelo pagamento|pagamento on.?line/;
const REIMBURSEMENT = /reembolso|ressarcimento|devolucao/;
const REFUND = /estorno|cashback/;
const SALARY = /salario|folha de pagamento|pagto salario|remuneracao|provento/;

const CATEGORY_KEYWORDS: [string, RegExp][] = [
  ['moradia', /aluguel|condominio|imobiliaria/],
  ['educacao', /escola|colegio|faculdade|curso|universidade|matricula|mensalidade escolar/],
  ['saude', /farmacia|drogaria|drogasil|raia|hospital|clinica|laboratorio|unimed|amil|bradesco saude|sulamerica|terapia|psicolog/],
  ['transporte', /\buber\b|\b99\b|\bposto\b|combustivel|shell|ipiranga|estacionamento|pedagio|sem parar|conectcar|ipva|seguro auto|mecanic/],
  ['mercado', /mercado|supermercado|assai|carrefour|atacadao|hortifruti|extra\b|pao de acucar|sacolao/],
  ['alimentacao', /ifood|restaurante|lanchonete|padaria|rappi|cafe|pizzaria|burger|mcdonald|starbucks|bar\b/],
  ['lazer', /netflix|spotify|cinema|steam|prime video|disney|hbo|ingresso|youtube/],
  ['servicos', /\bvivo\b|\bclaro\b|\btim\b|\boi\b|internet|energia|enel|sabesp|\bagua\b|\bluz\b|telefone|gas natural/],
];

export function suggest(opts: {
  description: string;
  direction: 'in' | 'out' | null;
  kind: TargetKind;
  ownNames: string[];
}): Suggestion {
  const d = normalizeText(opts.description);
  const base: Suggestion = { type: opts.direction === 'in' ? 'income' : 'expense', category_slug: null, skip_by_default: false, needs_review: false, note: null };

  if (opts.kind === 'card') {
    if (opts.direction === 'in' && INVOICE_PAYMENT_ON_CARD.test(d)) {
      return { ...base, type: 'expense', skip_by_default: true, note: 'Pagamento da fatura: é saída de caixa, não compra. Importe-o pelo extrato da conta.' };
    }
    const s = { ...base, type: 'expense' as const, category_slug: categoryFor(d), needs_review: false };
    if (opts.direction === 'in') s.note = 'Crédito/estorno: abate o gasto da fatura.';
    return s;
  }

  // Transferências entre minhas contas (ex.: PIX para "Fulano de Tal") não são despesa nem receita.
  const own = opts.ownNames.map(normalizeText).filter(Boolean);
  if (own.some((n) => d.includes(n))) {
    return { ...base, type: 'transfer', note: 'Transferência entre minhas contas — não conta como gasto nem receita.' };
  }
  if (opts.direction !== 'in' && OVERDRAFT_PAYMENT.test(d)) {
    return { ...base, type: 'overdraft_payment', note: 'Pagamento do cheque especial: reduz a dívida, não é despesa.' };
  }
  if (opts.direction !== 'in' && OVERDRAFT_COST.test(d)) {
    return { ...base, type: 'expense', category_slug: 'juros-tarifas', note: 'Juros e tarifas contam como despesa.' };
  }
  if (opts.direction !== 'in' && INVOICE_PAYMENT_ACCOUNT.test(d)) {
    return { ...base, type: 'invoice_payment', note: 'Pagamento de fatura: saída de caixa. As compras da fatura são os gastos.' };
  }
  if (opts.direction === 'in') {
    if (REIMBURSEMENT.test(d)) return { ...base, type: 'reimbursement', needs_review: true, note: 'Reembolso recebido — vincule à despesa depois.' };
    if (SALARY.test(d)) return { ...base, type: 'income', category_slug: 'salario' };
    if (REFUND.test(d)) return { ...base, type: 'income', needs_review: true, note: 'Estorno: confirme se não deve abater uma despesa.' };
    return { ...base, type: 'income', needs_review: true, note: 'Entrada sem tipo claro — confirme se é receita, reembolso ou transferência.' };
  }
  return { ...base, category_slug: categoryFor(d) };
}

export function categoryFor(normalizedDescription: string): string | null {
  for (const [slug, re] of CATEGORY_KEYWORDS) if (re.test(normalizedDescription)) return slug;
  return null;
}

/**
 * Impressão digital de uma linha importada, para detectar reimportação do mesmo arquivo.
 * Guarda apenas o hash — não o texto original. `occurrence` diferencia linhas idênticas no mesmo arquivo.
 */
export function fingerprint(target: string, date: string, absCents: number, description: string, occurrence: number): string {
  return createHash('sha256')
    .update(`${target}|${date}|${absCents}|${normalizeText(description)}|${occurrence}`)
    .digest('hex')
    .slice(0, 40);
}
