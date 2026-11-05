/** Linha lida de um arquivo, antes de classificar. Os textos nunca são gravados em log. */
export interface ParsedRow {
  date: string | null;
  description: string;
  /** Valor absoluto em centavos. */
  abs_cents: number;
  /** 'in' = entrou / crédito, 'out' = saiu / compra. null = o arquivo não deixa claro (exige escolha manual). */
  direction: 'in' | 'out' | null;
  /** Motivo pelo qual a linha precisa de conferência manual. */
  uncertain_reason: string | null;
}

export type TargetKind = 'account' | 'card';
