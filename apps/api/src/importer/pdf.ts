import { parseDate, parseMoney, todayISO } from '../lib.js';
import { parseLayoutLines } from './layout.js';
import type { ParsedRow, TargetKind } from './types.js';

export class PdfError extends Error {
  constructor(message: string, public code: 'password' | 'unreadable' | 'empty') {
    super(message);
  }
}

export async function extractPdfText(buf: Buffer): Promise<string> {
  // Carregado só quando necessário: na hospedagem serverless o PDF é lido no navegador do usuário.
  const { PDFParse } = await import('pdf-parse');
  const parser = new PDFParse({ data: new Uint8Array(buf) });
  try {
    const result = await parser.getText();
    return result.text ?? '';
  } catch (err) {
    const info = `${(err as Error).name} ${(err as Error).message}`;
    if (/password/i.test(info)) {
      throw new PdfError(
        'O PDF está protegido por senha. Remova a proteção no seu leitor de PDF e envie de novo — o sistema não pede nem guarda senhas.',
        'password',
      );
    }
    throw new PdfError('Não foi possível ler este PDF.', 'unreadable');
  } finally {
    await parser.destroy().catch(() => undefined);
  }
}

export type PdfConfidence = 'ok' | 'low' | 'none';

export interface PdfParseResult {
  rows: ParsedRow[];
  confidence: PdfConfidence;
  /** Linhas que começam com data (candidatas a lançamento) e quantas foram interpretadas. */
  candidate_lines: number;
  parsed_lines: number;
  /** Valores lidos do documento — apenas sugestões, o usuário confirma. */
  detected_due_date: string | null;
  detected_total_cents: number | null;
  reconciliation_cents: number | null;
  warnings: string[];
  /** Números sobre o texto lido (nunca o texto), para explicar na tela por que algo não foi reconhecido. */
  stats: { lines: number; lines_with_money: number; date_headers: number; reader: 'classic' | 'app' };
}

/** Correções leves e seguras para erros comuns de OCR (espaços perdidos/sobrando em valores e datas). */
export function cleanOcrText(text: string): string {
  return text
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    // "1.234 ,56" / "1.234, 56" -> "1.234,56"
    .replace(/(\d)\s+,(\d{2})(?!\d)/g, '$1,$2')
    .replace(/(\d),\s+(\d{2})(?!\d)/g, '$1,$2')
    // "12 / 03" -> "12/03"
    .replace(/(^|\s)(\d{2})\s*\/\s*(\d{2})(?=\s|\/|$)/g, '$1$2/$3')
    // "R $ 10,00" -> "R$ 10,00"
    .replace(/R\s*\$\s*/g, 'R$ ');
}

const MONTHS = 'jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez';
const DATE_AT_START = new RegExp(
  `^(\\d{2}/\\d{2}(?:/\\d{2,4})?|\\d{2}\\s+(?:${MONTHS})\\.?(?:\\s+\\d{4})?)\\s+(.+)$`,
  'i',
);
// Valor no formato brasileiro com vírgula decimal obrigatória (evita confundir com números de documento).
const MONEY_TOKEN = /(?:R\$\s?)?[-+]?\(?\d{1,3}(?:\.\d{3})*,\d{2}\)?-?(?:\s?[CD])?(?=\s|$)/g;

const TOTAL_RE = /(total (da |desta )?fatura|valor total( da fatura)?|total a pagar|total desta fatura)/i;
const DUE_RE = /vencimento\D{0,25}(\d{2}\/\d{2}\/\d{4})/i;

/**
 * Interpreta o texto extraído de um PDF de extrato/fatura.
 * Só aceita linhas "DATA  DESCRIÇÃO  VALOR". Qualquer ambiguidade (sinal desconhecido, duas colunas de valor,
 * data sem ano) fica marcada para conferência manual — nada é inventado.
 */
export function parseStatementText(
  text: string,
  opts: { kind: TargetKind; refMonth: string; ocr?: boolean; today?: string },
): PdfParseResult {
  const [refYear, refMon] = opts.refMonth.split('-').map(Number);
  const lines = (opts.ocr ? cleanOcrText(text) : text).split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let rows: ParsedRow[] = [];
  let candidates = 0;
  let detectedTotal: number | null = null;
  let detectedDue: string | null = null;
  let yearless = false;

  for (const line of lines) {
    if (detectedDue === null) {
      const d = line.match(DUE_RE);
      if (d) detectedDue = parseDate(d[1]);
    }
    if (detectedTotal === null && TOTAL_RE.test(line)) {
      const tokens = line.match(MONEY_TOKEN);
      if (tokens) detectedTotal = parseMoney(tokens[tokens.length - 1]);
    }

    const m = line.match(DATE_AT_START);
    if (!m) continue;
    const rest = m[2];
    // Linhas de saldo/total não são lançamentos.
    if (/^(saldo|sdo|total)\b|saldo (do dia|anterior|final|parcial|disponivel|disponível)/i.test(rest)) continue;
    candidates++;
    const tokens = [...rest.matchAll(MONEY_TOKEN)];
    if (!tokens.length) continue;

    const first = tokens[0];
    const description = rest.slice(0, first.index).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (description.length < 2) continue;

    const reasons: string[] = [];
    // Data sem ano: usa o ano do mês de referência; meses "depois" do mês de referência são do ano anterior
    // (ex.: compra de dezembro numa fatura de janeiro).
    const rawDate = m[1];
    const hasYear = /^\d{2}\/\d{2}\/\d{2,4}$/.test(rawDate) || /\s\d{4}$/.test(rawDate);
    let date = parseDate(rawDate, refYear);
    if (date && !hasYear) {
      yearless = true;
      if (Number(date.slice(5, 7)) > refMon) date = parseDate(rawDate, refYear - 1);
    }
    if (!date) continue;

    if (tokens.length > 1) reasons.push('mais de um valor na linha (valor e saldo?)');
    const signed = parseMoney(first[0]);
    if (signed === null || signed === 0) continue;
    const explicitSign = /^[-+(]|[-)]$|\s?[CD]$/i.test(first[0].trim());

    let direction: 'in' | 'out' | null;
    if (opts.kind === 'card') {
      // Em faturas, valor sem sinal é compra; sinal negativo/crédito é estorno ou pagamento.
      const suffix = first[0].trim().match(/\s?([CD])$/i)?.[1]?.toUpperCase();
      direction = suffix === 'C' || (suffix !== 'D' && signed < 0) ? 'in' : 'out';
    } else if (explicitSign) {
      direction = signed < 0 ? 'out' : 'in';
    } else {
      direction = null;
      reasons.push('o PDF não indica se é entrada ou saída');
    }
    rows.push({
      date,
      description,
      abs_cents: Math.abs(signed),
      direction,
      uncertain_reason: reasons.length ? reasons.join('; ') : null,
    });
  }

  const warnings: string[] = [];
  let confidence: PdfConfidence = 'ok';
  let reconciliation: number | null = null;

  // Formato de app de banco (data como título do grupo, valor em outra linha): tenta o leitor flexível
  // quando o leitor clássico não entendeu o documento.
  let layoutUsed = false;
  let dateHeaders = 0;
  if (rows.length === 0 || (candidates > 0 && rows.length < candidates * 0.8)) {
    const lay = parseLayoutLines(lines, { kind: opts.kind, refMonth: opts.refMonth, today: opts.today ?? todayISO() });
    if (lay.rows.length > rows.length) {
      rows = lay.rows;
      layoutUsed = true;
      dateHeaders = lay.dateHeaders;
      yearless = yearless || lay.yearless;
      warnings.push(
        `Formato de app reconhecido (${lay.dateHeaders} data${lay.dateHeaders === 1 ? '' : 's'} como título de grupo). Compare cada linha com a imagem.`,
      );
      if (lay.relativeDates) warnings.push('Há datas como "Hoje" ou "Ontem": foram convertidas pela data de hoje. Confira.');
      if (rows.some((r) => r.date === null)) warnings.push('Algumas linhas ficaram sem data. Informe a data antes de importar.');
    }
  }
  if (rows.length === 0) {
    confidence = 'none';
    warnings.push(
      'Não foi possível identificar lançamentos neste PDF com segurança. Use o CSV do banco (se houver) ou inclua os lançamentos manualmente.',
    );
  } else {
    if (!layoutUsed && rows.length < candidates * 0.8) {
      confidence = 'low';
      warnings.push(`Só ${rows.length} de ${candidates} linhas com data foram interpretadas.`);
    }
    if (opts.kind === 'card' && detectedTotal !== null) {
      const net = rows.reduce((s, r) => s + (r.direction === 'out' ? r.abs_cents : -r.abs_cents), 0);
      reconciliation = detectedTotal - net;
      if (reconciliation !== 0) {
        confidence = 'low';
        warnings.push('A soma das linhas não bate com o total da fatura lido no PDF. Confira cada linha.');
      }
    }
  }
  if (layoutUsed) confidence = 'low';
  if (opts.ocr && rows.length) {
    // Texto de imagem nunca é tratado como confiável: o usuário confere linha a linha.
    confidence = 'low';
    warnings.unshift('O texto foi lido de uma imagem (OCR) e pode ter erros de dígitos, datas ou valores. Compare cada linha com a imagem antes de importar.');
  }
  if (yearless && rows.length) {
    warnings.push(`As datas do documento não trazem o ano; foi usado o ano do mês de referência (${opts.refMonth.split('-').reverse().join('/')}). Confira.`);
  }
  return {
    rows,
    confidence,
    candidate_lines: candidates,
    parsed_lines: rows.length,
    detected_due_date: detectedDue,
    detected_total_cents: detectedTotal,
    reconciliation_cents: reconciliation,
    warnings,
    stats: {
      lines: lines.length,
      lines_with_money: lines.filter((l) => l.match(MONEY_TOKEN) !== null).length,
      date_headers: dateHeaders,
      reader: layoutUsed ? 'app' : 'classic',
    },
  };
}
