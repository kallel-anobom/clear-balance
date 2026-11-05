import { createHash } from 'node:crypto';
import { normalizeText } from '../lib.js';

export interface InstallmentInfo {
  /** Parcela atual (1..total) e total de parcelas. */
  no: number;
  total: number;
  /** Descrição sem o marcador de parcela, usada para reconhecer a mesma compra nas próximas faturas. */
  base: string;
  /** true quando só havia "03/10" solto no fim da descrição (pode ser outra coisa — o usuário confere). */
  bare: boolean;
}

const MAX_TOTAL = 120;

// "PARC 02/10", "PARCELA 2 DE 10", "PARC.02/10", "Parcela: 3/6"
const EXPLICIT = /\bparc(?:ela|\.)?\s*:?\s*0?(\d{1,3})\s*(?:\/|\bde\b)\s*0?(\d{1,3})(?!\d)/i;
// "LOJA XYZ 03/10" (somente no fim da descrição, para não confundir com datas no meio do texto)
const BARE_AT_END = /(?:^|\s)\(?0?(\d{1,2})\s*\/\s*0?(\d{1,2})\)?\s*$/;

function clean(s: string): string {
  return s
    .replace(/\bparc(?:elas?|\.)?\b\s*:?/gi, ' ')
    .replace(/\s*[-–*:]+\s*$/, '')
    .replace(/^\s*[-–*:]+\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Reconhece parcelamento na descrição de uma compra de cartão. Devolve null se não houver marcador confiável. */
export function detectInstallment(description: string): InstallmentInfo | null {
  const d = description.trim();
  let m = d.match(EXPLICIT);
  let bare = false;
  if (!m) {
    m = d.match(BARE_AT_END);
    bare = true;
  }
  if (!m) return null;
  const no = Number(m[1]);
  const total = Number(m[2]);
  if (!(total >= 2 && total <= MAX_TOTAL && no >= 1 && no <= total)) return null;
  const base = clean(d.replace(m[0], ' '));
  if (base.length < 2) return null;
  return { no, total, base, bare };
}

/** Identifica a mesma compra parcelada: cartão + descrição base + total de parcelas. O valor fica de fora porque a última parcela costuma variar centavos. */
export function installmentGroup(cardId: number, base: string, total: number): string {
  return createHash('sha256').update(`card:${cardId}|${normalizeText(base)}|${total}`).digest('hex').slice(0, 24);
}
