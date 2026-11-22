import { normalizeText, parseDate, parseMoney, todayISO } from '../lib.js';
import { IN_HINT, parseLayoutLines } from './layout.js';
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
  stats: { lines: number; lines_with_money: number; date_headers: number; reader: 'classic' | 'app' | 'ai' };
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
// "3 06/08 LOJA ..." (Santander): o dígito antes da data é a coluna "Compra", não faz parte do lançamento.
const DATE_AT_START = new RegExp(
  `^(?:\\d\\s(?=\\d{2}/\\d{2}\\s))?(\\d{2}/\\d{2}(?:/\\d{2,4})?|\\d{2}\\s+(?:${MONTHS})\\.?(?:\\s+\\d{4})?)\\s+(.+)$`,
  'i',
);
// Valor no formato brasileiro com vírgula decimal obrigatória (evita confundir com números de documento).
// Aceita o sinal antes ou depois do "R$" ("-R$ 4,54" e "R$ -4,54").
const MONEY_TOKEN = /[-+]?(?:R\$\s?)?[-+]?\(?\d{1,3}(?:\.\d{3})*,\d{2}\)?-?(?:\s?[CD])?(?=\s|$)/g;

// "Total a pagar" e afins são o total desta fatura; "Total da fatura" genérico pode ser o da fatura anterior
// (ex.: "Total da fatura de setembro" no resumo), por isso só vale se nenhum total forte aparecer.
const STRONG_TOTAL_RE = /(total a pagar|valor total( da fatura)?|total desta fatura)/i;
const WEAK_TOTAL_RE = /total (da )?fatura|^subtotal\b/i;
const PREVIOUS_TOTAL_RE = /anterior|fatura de (jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)/i;
/** Pagamento da fatura anterior dentro da própria fatura: não faz parte do total a pagar. */
export function isStatementPaymentLine(description: string): boolean {
  return /pagamento (recebido|efetuado|em \d{1,2}|d[ae] fatura|fatura|on.?line)|pgto (fatura|recebido)|credito de pagamento|obrigado pelo pagamento|debito autom/.test(
    normalizeText(description),
  );
}
const MONEY_TOKEN_TEST = new RegExp(MONEY_TOKEN.source);
const LONE_MONEY_RE = /^[-+]?(?:R\$\s?)?[-+]?\d{1,3}(?:\.\d{3})*,\d{2}$/;
// Rodapé/cabeçalho de página que não faz parte da descrição ("-- 1 of 6 --", "Data Lançamentos ...").
const PAGE_NOISE_RE = /^--\s*\d+\s+of\s+\d+\s*--$|^data\s+lan[cç]/i;
const ENDS_WITH_MONEY_RE = /(?:^|\s)[-+]?(?:R\$\s?)?[-+]?\d{1,3}(?:\.\d{3})*,\d{2}$/;
const DUE_RE = /vencimento\D{0,25}(\d{2}\/\d{2}\/\d{4})/i;
// Valor com ponto decimal e vírgula de milhar ("-6,436.50"): o app do Itaú exporta assim a fatura aberta.
const US_MONEY_RE = /(?<![\d.,])(-?)(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})(?![\d.,])/g;
const BR_MONEY_COUNT_RE = /\d,\d{2}(?!\d)/g;

/**
 * Se o documento só usa o formato americano de valores, converte para o brasileiro antes de ler.
 * Só age quando há vários valores assim e nenhum (ou muito poucos) no formato brasileiro, para não
 * mexer em PDFs normais.
 */
export function normalizeUsDecimals(text: string): string {
  const us = (text.match(US_MONEY_RE) ?? []).length;
  const br = (text.match(BR_MONEY_COUNT_RE) ?? []).length;
  if (us < 3 || br * 3 > us) return text;
  return text.replace(US_MONEY_RE, (_m, sign: string, int: string, cents: string) => `${sign}${int.replace(/,/g, '.')},${cents}`);
}

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
  // PDFs de banco usam o sinal de menos tipográfico (U+2212) e travessões: sem trocar por "-", crédito viraria compra.
  const lines = normalizeUsDecimals((opts.ocr ? cleanOcrText(text) : text).replace(/[\u2212\u2012\u2013]/g, '-'))
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  let rows: ParsedRow[] = [];
  let candidates = 0;
  let detectedTotal: number | null = null;
  const strongTotals: number[] = [];
  let weakTotal: number | null = null;
  let detectedDue: string | null = null;
  let yearless = false;
  // Se o documento usa "-" nas saídas (vários valores negativos), o valor sem sinal é entrada.
  const marksOutflows = opts.kind !== 'card' && lines.filter((l) => /(?:^|\s)-\s?(?:R\$\s?)?\d{1,3}(?:\.\d{3})*,\d{2}$/.test(l)).length >= 3;

  for (const [lineNo, line] of lines.entries()) {
    if (detectedDue === null) {
      const d = line.match(DUE_RE);
      if (d) detectedDue = parseDate(d[1]);
      else if (/vencimento\s*$/i.test(line)) {
        // Tabela "Cartão | Valor (parcial) | Vencimento": a data vem no fim da linha seguinte.
        const next = lines[lineNo + 1]?.match(/(\d{2}\/\d{2}\/\d{4})$/);
        if (next) detectedDue = parseDate(next[1]);
      }
    }
    if (STRONG_TOTAL_RE.test(line)) {
      // O valor pode estar na mesma linha ou na seguinte (layout "Total a pagar" / "R$ 978,05").
      const tokens = line.match(MONEY_TOKEN) ?? (/^(?:R\$\s?)?[\d.]+,\d{2}$/.test(lines[lineNo + 1] ?? '') ? lines[lineNo + 1].match(MONEY_TOKEN) : null);
      const value = tokens ? parseMoney(tokens[tokens.length - 1]) : null;
      if (value !== null) {
        // Há faturas com mais de um "Total a pagar" (ex.: simulação de parcelamento); o certo é decidido pela soma das linhas.
        strongTotals.push(value);
        detectedTotal ??= value;
      }
    } else if (weakTotal === null && WEAK_TOTAL_RE.test(line) && !PREVIOUS_TOTAL_RE.test(line)) {
      const tokens = line.match(MONEY_TOKEN);
      if (tokens) weakTotal = parseMoney(tokens[tokens.length - 1]);
    }

    const m = line.match(DATE_AT_START);
    if (!m) continue;
    const rest = m[2];
    // Linhas de saldo/total não são lançamentos.
    if (/^(saldo|sdo|total)\b|saldo (do dia|anterior|final|parcial|disponivel|disponível)/i.test(rest)) continue;
    // "13/11/2026 11.033,70": saldo do dia, só tem valor — não é lançamento nem candidato.
    if (LONE_MONEY_RE.test(rest)) continue;
    candidates++;
    let restWithValue = rest;
    // Compra em moeda estrangeira: o valor em reais vem numa linha só dele, logo abaixo (depois da cotação).
    if (opts.kind === 'card' && !MONEY_TOKEN_TEST.test(rest)) {
      for (const next of lines.slice(lineNo + 1, lineNo + 4)) {
        if (DATE_AT_START.test(next)) break;
        if (LONE_MONEY_RE.test(next)) { restWithValue = `${rest} ${next}`; break; }
      }
      // Descrição quebrada em duas linhas, com o valor no fim da segunda ("Iof Internacional - Loja" / "Cidade R$ 4,10").
      const next = lines[lineNo + 1];
      if (
        restWithValue === rest &&
        next &&
        !DATE_AT_START.test(next) &&
        !PAGE_NOISE_RE.test(next) &&
        MONEY_TOKEN_TEST.test(next) &&
        !/cota[cç][aã]o|usd|eur\b|d[oó]lar/i.test(next)
      ) {
        restWithValue = `${rest} ${next}`;
      }
    }
    // Extrato em que a descrição quebra em várias linhas e o valor vem na última ("PIX ENVIADO ..." / "NOME" / "-240,00").
    if (opts.kind !== 'card' && !MONEY_TOKEN_TEST.test(rest)) {
      const parts: string[] = [];
      for (const next of lines.slice(lineNo + 1, lineNo + 6)) {
        if (DATE_AT_START.test(next) || PAGE_NOISE_RE.test(next)) break;
        if (ENDS_WITH_MONEY_RE.test(next)) { restWithValue = [rest, ...parts, next].join(' '); break; }
        parts.push(next);
      }
    }
    // "R$ 112,75 USD 18,95": o valor na moeda original vem depois do valor em reais e não é um segundo valor.
    restWithValue = restWithValue.replace(/\b(?:USD|EUR|GBP|US\$)\s*-?\d{1,3}(?:\.\d{3})*,\d{2}\b/g, ' ');
    const tokens = [...restWithValue.matchAll(MONEY_TOKEN)];
    if (!tokens.length) continue;

    const first = tokens[0];
    // Faturas Nubank trazem "•••• 5802" (final do cartão) antes do estabelecimento: não é parte do nome.
    const description = restWithValue.slice(0, first.index).replace(/^[•·*]{2,}\s?\d{4}\s+/, '').replace(/\s+/g, ' ').trim().slice(0, 200);
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
    } else if (marksOutflows) {
      // Extrato que marca as saídas com "-": valor sem sinal é entrada. Só fica sem aviso quando o texto confirma.
      direction = 'in';
      if (!IN_HINT.test(normalizeText(description))) reasons.push('sem sinal: lido como entrada, pois este extrato marca as saídas com "-"');
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

  detectedTotal ??= weakTotal;
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
      const net = rows.filter((r) => !isStatementPaymentLine(r.description)).reduce((s, r) => s + (r.direction === 'out' ? r.abs_cents : -r.abs_cents), 0);
      if (strongTotals.includes(net)) detectedTotal = net;
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
