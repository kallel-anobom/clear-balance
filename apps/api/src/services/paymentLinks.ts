import { diffDays, normalizeText } from '../lib.js';

/**
 * Pagamentos de fatura que saíram da conta (extrato) mas ainda não foram ligados a uma fatura.
 * Sugere a fatura certa por: cartão citado na descrição, valor igual ao da fatura e data de vencimento próxima.
 * Função pura: só sugere; quem confirma o vínculo é o usuário.
 */

export interface UnlinkedPayment {
  id: number;
  description: string;
  total_cents: number;
  paid_on: string | null;
  card_id: number | null;
}

export interface OpenInvoice {
  id: number;
  card_id: number;
  card_name: string;
  due_date: string;
  amount_cents: number;
}

export interface LinkSuggestion {
  invoice_id: number;
  confidence: 'alta' | 'media';
  reason: string;
}

export interface PaymentLinkInfo {
  suggestion: LinkSuggestion | null;
  /** Faturas que fazem sentido para este pagamento, da mais provável para a menos provável. */
  candidate_invoice_ids: number[];
  /** Não parece pagamento de fatura (sem data ou sem palavra de pagamento): provavelmente é outro tipo de lançamento. */
  suspicious: boolean;
}

// Pago até 20 dias depois do vencimento ou até 10 dias antes dele.
const SUGGEST_WINDOW = { min: -20, max: 10 };
// Para a lista de opções, uma janela maior.
const CANDIDATE_WINDOW = { min: -60, max: 30 };
const PAYMENT_WORDS = /fatura|cartao|pagamento|pgto|pag\b/;
const GENERIC_TOKENS = new Set(['cartao', 'credito', 'card', 'fatura', 'azul', 'elite', 'gold', 'black', 'platinum', 'plat']);

/** Palavras do nome do cartão que identificam o banco (ex.: "Itau Azul" -> "itau"). */
function cardTokens(name: string): string[] {
  return normalizeText(name).split(/[^a-z0-9]+/).filter((t) => t.length >= 4 && !GENERIC_TOKENS.has(t));
}

const daysUntilDue = (inv: OpenInvoice, paidOn: string) => diffDays(inv.due_date, paidOn);

export function suggestPaymentLinks(payments: UnlinkedPayment[], invoices: OpenInvoice[]): Map<number, PaymentLinkInfo> {
  const out = new Map<number, PaymentLinkInfo>();
  const used = new Set<number>(); // uma fatura só é sugerida para um pagamento

  // Pagamentos mais antigos primeiro, para a sugestão de cada fatura ir para o pagamento mais próximo no tempo.
  const ordered = [...payments].sort((a, b) => (a.paid_on ?? '9999').localeCompare(b.paid_on ?? '9999') || a.id - b.id);
  for (const p of ordered) {
    const desc = normalizeText(p.description);
    const suspicious = p.paid_on === null || !PAYMENT_WORDS.test(desc);

    // Cartão: o do próprio lançamento ou o citado na descrição ("... Banco Santander").
    const hinted = new Set<number>();
    if (p.card_id !== null) hinted.add(p.card_id);
    else for (const inv of invoices) if (cardTokens(inv.card_name).some((t) => desc.includes(t))) hinted.add(inv.card_id);
    const sameCard = (i: OpenInvoice) => hinted.size === 0 || hinted.has(i.card_id);

    const pool = invoices.filter((i) => sameCard(i));
    const inWindow = (w: { min: number; max: number }) => (i: OpenInvoice) => {
      if (p.paid_on === null) return true;
      const d = daysUntilDue(i, p.paid_on);
      return d >= w.min && d <= w.max;
    };
    const distance = (i: OpenInvoice) => (p.paid_on === null ? 0 : Math.abs(daysUntilDue(i, p.paid_on)));

    const candidates = pool
      .filter(inWindow(CANDIDATE_WINDOW))
      .sort((a, b) => Math.abs(a.amount_cents - p.total_cents) - Math.abs(b.amount_cents - p.total_cents) || distance(a) - distance(b));

    let suggestion: LinkSuggestion | null = null;
    if (!suspicious) {
      const near = pool.filter(inWindow(SUGGEST_WINDOW)).filter((i) => !used.has(i.id));
      const exact = near.filter((i) => Math.abs(i.amount_cents - p.total_cents) <= 1).sort((a, b) => distance(a) - distance(b))[0];
      const close = near
        .filter((i) => i.amount_cents > 0 && Math.abs(i.amount_cents - p.total_cents) / i.amount_cents <= 0.02)
        .sort((a, b) => distance(a) - distance(b))[0];
      if (exact) suggestion = { invoice_id: exact.id, confidence: 'alta', reason: 'Mesmo valor e vencimento próximo da data do pagamento.' };
      else if (close) suggestion = { invoice_id: close.id, confidence: 'media', reason: 'Valor parecido (até 2% de diferença) e vencimento próximo. Confira antes de vincular.' };
    }
    if (suggestion) used.add(suggestion.invoice_id);
    out.set(p.id, { suggestion, candidate_invoice_ids: candidates.map((i) => i.id), suspicious });
  }
  return out;
}
