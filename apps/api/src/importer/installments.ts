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

/** Parcela já gravada (real ou prevista) de uma compra parcelada. */
export interface GroupMember {
  group: string;
  no: number;
  cents: number;
  is_projected: boolean;
}

/** Valores "do mesmo parcelamento": até R$ 1,00 ou 2% de diferença (a última parcela costuma variar centavos). */
export function sameInstallmentAmount(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(100, Math.round(Math.max(a, b) * 0.02));
}

/**
 * Compras diferentes na mesma loja e com o mesmo número de parcelas (ex.: duas compras "LOJA Parcela 2 de 12" com valores
 * distintos) cairiam no mesmo grupo. Aqui o valor desempata: a parcela vai para o grupo cujo valor combina; se nenhum
 * combina e a vaga já foi confirmada em fatura, é outra compra e ganha um grupo novo (`<grupo>~2`, `~3`...).
 * `members` são as parcelas já gravadas do grupo base e de suas variantes.
 */
export function pickInstallmentGroup(
  baseGroup: string,
  no: number,
  cents: number,
  members: GroupMember[],
): { group: string; existing: GroupMember | null } {
  const groups = [...new Set(members.map((m) => m.group))];
  if (!groups.length) return { group: baseGroup, existing: null };
  const of = (g: string) => members.filter((m) => m.group === g);

  // 1) A vaga desta parcela já existe com valor compatível.
  for (const g of groups) {
    const slot = of(g).find((m) => m.no === no);
    if (slot && sameInstallmentAmount(slot.cents, cents)) return { group: g, existing: slot };
  }
  // 2) Grupo sem esta parcela cujo valor combina com as outras parcelas dele.
  for (const g of groups) {
    const ms = of(g);
    if (ms.some((m) => m.no === no)) continue;
    const nearest = ms.reduce((a, b) => (Math.abs(a.no - no) <= Math.abs(b.no - no) ? a : b));
    if (sameInstallmentAmount(nearest.cents, cents)) return { group: g, existing: null };
  }
  // 3) Vaga apenas prevista pelo sistema, com valor diferente: confirma com o valor real (preço mudou).
  const projected = groups
    .map((g) => of(g).find((m) => m.no === no && m.is_projected))
    .filter((m): m is GroupMember => !!m)
    .sort((a, b) => Math.abs(a.cents - cents) - Math.abs(b.cents - cents));
  if (projected.length) return { group: projected[0].group, existing: projected[0] };
  // 4) É outra compra: grupo novo.
  if (!groups.includes(baseGroup)) return { group: baseGroup, existing: null };
  let k = 2;
  while (groups.includes(`${baseGroup}~${k}`)) k++;
  return { group: `${baseGroup}~${k}`, existing: null };
}
