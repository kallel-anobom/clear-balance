import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PoolClient } from 'pg';
import { pool, withTx, type Queryable } from '../db.js';
import { config } from '../config.js';
import { HttpError, badRequest } from '../errors.js';
import { diffDays, isValidDate, monthOf, normalizeText } from '../lib.js';
import { fingerprint, merchantKey, suggest, type LearnedRule } from '../importer/classify.js';
import { detectInstallment, installmentGroup } from '../importer/installments.js';
import { parseCsv, type CsvMapping } from '../importer/csv.js';
import { extractPdfText, parseStatementText, PdfError } from '../importer/pdf.js';
import { AiError, interpretWithAi } from '../importer/llm.js';
import { redact } from '../importer/redact.js';
import { countAiCall, getAiState } from '../services/ai.js';
import type { ParsedRow, TargetKind } from '../importer/types.js';
import { findOrCreateInvoice, invoiceDatesForDue, syncInvoicePaid } from '../services/invoices.js';
import { confirmProjectedInstallment, dateInInvoiceCycle, projectInstallments } from '../services/installments.js';
import { createTransaction, updateTransaction } from '../services/transactions.js';

type Action = 'create' | 'skip' | 'link';

interface ExistingTx {
  id: number;
  type: string;
  description: string;
  total_cents: number;
  occurred_on: string | null;
  due_date: string | null;
  paid_on: string | null;
  month_ref: string;
  status: string;
  account_id: number | null;
  transfer_account_id: number | null;
  card_id: number | null;
  import_hash: string | null;
}

const txDate = (t: ExistingTx) => t.paid_on ?? t.occurred_on ?? t.due_date;

/** Candidatas a "mesmo lançamento" já cadastrado (digitado à mão ou agendado), com valor igual e data próxima. */
function findPossibleDuplicate(
  row: { date: string; abs_cents: number; direction: 'in' | 'out' | null },
  target: { kind: TargetKind; id: number },
  candidates: ExistingTx[],
  used: Set<number>,
): ExistingTx | null {
  for (const t of candidates) {
    if (used.has(t.id) || Math.abs(t.total_cents) !== row.abs_cents) continue;
    const d = txDate(t);
    const near = d ? Math.abs(diffDays(d, row.date)) <= 3 : t.month_ref === monthOf(row.date);
    if (!near) continue;
    let sameTarget: boolean;
    if (target.kind === 'card') sameTarget = t.card_id === target.id && t.type === 'expense';
    else if (t.type === 'transfer') {
      // Transferência já registrada pelo outro lado (ou com uma ponta ainda sem conta).
      sameTarget = t.account_id === target.id || t.transfer_account_id === target.id || t.account_id === null || t.transfer_account_id === null;
    } else sameTarget = t.account_id === target.id || (t.account_id === null && t.status === 'scheduled'); // previsto ainda sem conta definida
    if (!sameTarget) continue;
    if (row.direction === 'out' && ['income', 'reimbursement'].includes(t.type)) continue;
    if (row.direction === 'in' && ['invoice_payment', 'overdraft_payment'].includes(t.type)) continue;
    used.add(t.id);
    return t;
  }
  return null;
}

const previewFields = z.object({
  target_type: z.enum(['account', 'card']),
  target_id: z.coerce.number().int().positive(),
  ref_month: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  invert_sign: z.enum(['true', 'false']).optional(),
  mapping: z.string().optional(),
});

const previewTextBody = z.object({
  target_type: z.enum(['account', 'card']),
  target_id: z.number().int().positive(),
  ref_month: z.string().regex(/^\d{4}-\d{2}$/),
  origin: z.enum(['pdf', 'ocr']),
  text: z.string().min(1).max(2_000_000),
});

const commitRow = z.object({
  date: z.string().refine(isValidDate),
  description: z.string().trim().min(1).max(200),
  abs_cents: z.number().int().positive(),
  direction: z.enum(['in', 'out']),
  type: z.enum(['income', 'expense', 'transfer', 'reimbursement', 'invoice_payment', 'overdraft_payment']),
  category_id: z.number().int().positive().nullable().optional(),
  needs_review: z.boolean().optional(),
  action: z.enum(['create', 'skip', 'link']),
  link_to_id: z.number().int().positive().nullable().optional(),
  hash: z.string().max(100).nullable().optional(),
  transfer_account_id: z.number().int().positive().nullable().optional(),
  card_id: z.number().int().positive().nullable().optional(),
  /** "Lembrar esta correção": grava uma regra com o nome do estabelecimento (sem valores nem datas). */
  remember: z.boolean().optional(),
});

const commitBody = z.object({
  target_type: z.enum(['account', 'card']),
  target_id: z.number().int().positive(),
  source_kind: z.enum(['csv', 'pdf', 'image']),
  label: z.string().trim().max(120).optional(),
  invoice_due_date: z.string().refine(isValidDate).nullable().optional(),
  statement_total_cents: z.number().int().nullable().optional(),
  rows: z.array(commitRow).max(5000),
});


type CommitBody = z.infer<typeof commitBody>;
type CommitRow = z.infer<typeof commitRow>;

export async function importRoutes(app: FastifyInstance) {
  app.post('/import/preview', async (req) => {
    const file = await req.file({ limits: { fileSize: config.maxUploadBytes, files: 1 } });
    if (!file) throw badRequest('Envie um arquivo CSV ou PDF.');
    const f = (name: string) => (file.fields[name] as { value?: string } | undefined)?.value;
    const fields = previewFields.parse({
      target_type: f('target_type'),
      target_id: f('target_id'),
      ref_month: f('ref_month') || undefined,
      invert_sign: f('invert_sign') || undefined,
      mapping: f('mapping') || undefined,
    });
    const buf = await file.toBuffer();
    if (file.file.truncated) throw new HttpError(413, 'Arquivo grande demais (limite de 15 MB).');
    // O tipo vem do conteúdo (assinatura %PDF), não só da extensão.
    const isPdf = buf.subarray(0, 5).toString('latin1') === '%PDF-';
    const kind: TargetKind = fields.target_type;

    const targetTable = kind === 'card' ? 'cards' : 'accounts';
    const exists = await pool.query(`select 1 from ${targetTable} where id = $1`, [fields.target_id]);
    if (!exists.rowCount) throw badRequest(kind === 'card' ? 'Cartão não encontrado.' : 'Conta não encontrada.');

    let rows: ParsedRow[] = [];
    let skipped = 0;
    let csvInfo: { headers: string[]; sample: string[][]; mapping: Partial<CsvMapping>; needs_mapping: boolean } | null = null;
    let pdfInfo: Omit<ReturnType<typeof parseStatementText>, 'rows'> | null = null;

    if (isPdf) {
      if (!fields.ref_month) throw badRequest('Para PDF, informe o mês de referência (mês da fatura ou do extrato).');
      let text: string;
      try {
        text = await extractPdfText(buf);
      } catch (e) {
        if (e instanceof PdfError) throw badRequest(e.message);
        throw e;
      }
      const parsed = parseStatementText(text, { kind, refMonth: fields.ref_month });
      const { rows: r, ...info } = parsed;
      rows = r;
      pdfInfo = info;
    } else {
      let mapping: Partial<CsvMapping> | undefined;
      if (fields.mapping) {
        try {
          mapping = JSON.parse(fields.mapping);
        } catch {
          throw badRequest('Mapeamento de colunas inválido.');
        }
      }
      const parsed = parseCsv(buf, { kind, mapping, invertSign: fields.invert_sign === 'true' });
      rows = parsed.rows;
      skipped = parsed.skipped;
      csvInfo = { headers: parsed.headers, sample: parsed.sample, mapping: parsed.mapping, needs_mapping: parsed.needs_mapping };
    }
    if (rows.length > 5000) throw badRequest('Arquivo com linhas demais (máximo de 5.000 por importação).');
    return enrichPreview({
      kind, targetId: fields.target_id, rows, skipped, csvInfo, pdfInfo, sourceKind: isPdf ? 'pdf' : 'csv',
    });
  });

  // Texto já extraído no navegador (PDF com texto ou OCR de imagem): só o texto trafega, nunca o arquivo.
  app.post('/import/preview-text', async (req) => {
    const b = previewTextBody.parse(req.body);
    const kind: TargetKind = b.target_type;
    const targetTable = kind === 'card' ? 'cards' : 'accounts';
    const exists = await pool.query(`select 1 from ${targetTable} where id = $1`, [b.target_id]);
    if (!exists.rowCount) throw badRequest(kind === 'card' ? 'Cartão não encontrado.' : 'Conta não encontrada.');
    const parsed = parseStatementText(b.text, { kind, refMonth: b.ref_month, ocr: b.origin === 'ocr' });
    const { rows, ...pdfInfo } = parsed;
    if (rows.length > 5000) throw badRequest('Texto com linhas demais (máximo de 5.000 por importação).');
    return enrichPreview({
      kind, targetId: b.target_id, rows, skipped: 0, csvInfo: null, pdfInfo, sourceKind: b.origin === 'ocr' ? 'image' : 'pdf',
    });
  });

  // Leitor de reserva com IA (opcional, só ao clicar). Recebe o texto, anonimiza e devolve uma PROPOSTA:
  // as linhas chegam desmarcadas e o usuário revisa tudo antes de salvar.
  app.post('/import/ai-text', async (req) => {
    const b = previewTextBody.parse(req.body);
    const kind: TargetKind = b.target_type;
    const targetTable = kind === 'card' ? 'cards' : 'accounts';
    const exists = await pool.query(`select 1 from ${targetTable} where id = $1`, [b.target_id]);
    if (!exists.rowCount) throw badRequest(kind === 'card' ? 'Cartão não encontrado.' : 'Conta não encontrada.');

    const state = await getAiState(pool);
    if (!state.enabled) throw new HttpError(403, 'A IA está desligada. Ligue em Configurações › IA (opcional).');
    if (!state.available) throw new HttpError(503, 'A IA não está configurada no servidor (falta a chave da Anthropic).');
    if (state.calls >= state.limit) {
      throw new HttpError(429, `Limite de ${state.limit} usos da IA neste mês atingido. Use a revisão manual ou espere o próximo mês.`);
    }

    const [cats, ruleRows] = await Promise.all([
      pool.query('select slug, name, kind from categories order by kind desc, name'),
      pool.query(
        `select r.pattern, c.slug from learned_rules r join categories c on c.id = r.category_id
         where r.kind = $1 order by r.use_count desc, r.last_used_at desc limit 10`,
        [kind],
      ),
    ]);

    await countAiCall(pool, state);
    let ai;
    try {
      ai = await interpretWithAi(redact(b.text), {
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
        kind,
        refMonth: b.ref_month,
        categories: cats.rows,
        examples: ruleRows.rows.map((r) => ({ merchant: r.pattern, category_slug: r.slug })),
        timeoutMs: config.aiTimeoutMs,
      });
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(e.status, e.message);
      throw e;
    }

    // Vencimento e total da fatura vêm do leitor de regras (se achar), para conferir a soma da IA.
    const classic = parseStatementText(b.text, { kind, refMonth: b.ref_month, ocr: true });
    const warnings = [...ai.warnings];
    let reconciliation: number | null = null;
    if (kind === 'card' && classic.detected_total_cents !== null) {
      const net = ai.rows.reduce((s, r) => s + (r.direction === 'out' ? r.abs_cents : -r.abs_cents), 0);
      reconciliation = classic.detected_total_cents - net;
      if (reconciliation !== 0) warnings.push('A soma das linhas da IA não bate com o total da fatura lido no texto. Confira cada linha.');
    }
    const lines = b.text.split('\n');
    return enrichPreview({
      kind, targetId: b.target_id, rows: ai.rows, skipped: 0, csvInfo: null, sourceKind: b.origin === 'ocr' ? 'image' : 'pdf',
      pdfInfo: {
        confidence: 'low',
        candidate_lines: ai.rows.length,
        parsed_lines: ai.rows.length,
        detected_due_date: classic.detected_due_date,
        detected_total_cents: classic.detected_total_cents,
        reconciliation_cents: reconciliation,
        warnings,
        stats: { lines: lines.length, lines_with_money: classic.stats.lines_with_money, date_headers: 0, reader: 'ai' },
      },
    });
  });

  app.post('/import/commit', async (req, reply) => {
    const b = commitBody.parse(req.body);
    const result = await withTx((c) => commit(c, b));
    reply.code(201);
    return result;
  });
}

interface PreviewInput {
  kind: TargetKind;
  targetId: number;
  rows: ParsedRow[];
  skipped: number;
  csvInfo: { headers: string[]; sample: string[][]; mapping: Partial<CsvMapping>; needs_mapping: boolean } | null;
  pdfInfo: Omit<ReturnType<typeof parseStatementText>, 'rows'> | null;
  sourceKind: 'csv' | 'pdf' | 'image';
}

/** Classificação, categorias e detecção de duplicatas — comum a CSV, PDF e imagem (OCR). */
async function enrichPreview({ kind, targetId, rows, skipped, csvInfo, pdfInfo, sourceKind }: PreviewInput) {
  // ----- Enriquecimento: classificação, categorias, duplicatas -----
  const [cats, settings, history, rulesRes] = await Promise.all([
    pool.query('select id, slug from categories'),
    pool.query(`select value from settings where key = 'own_transfer_names'`),
    pool.query(`select description, category_id from transactions where category_id is not null order by id desc limit 3000`),
    pool.query('select id, kind, pattern, category_id, type, ignore, use_count from learned_rules'),
  ]);
  const rules: LearnedRule[] = rulesRes.rows;
  const catBySlug = new Map<string, number>(cats.rows.map((c) => [c.slug, c.id]));
  const ownNames: string[] = settings.rows[0]?.value ?? [];
  const learned = new Map<string, number>();
  for (const h of history.rows) {
    const k = normalizeText(h.description);
    if (!learned.has(k)) learned.set(k, h.category_id);
  }

  const targetKey = `${kind === 'card' ? 'card' : 'acc'}:${targetId}`;
  const seen = new Map<string, number>();
  const hashes: string[] = [];
  const withHash = rows.map((r) => {
    const base = `${r.date}|${r.abs_cents}|${normalizeText(r.description)}`;
    const occ = seen.get(base) ?? 0;
    seen.set(base, occ + 1);
    const hash = r.date ? fingerprint(targetKey, r.date, r.abs_cents, r.description, occ) : null;
    if (hash) hashes.push(hash);
    return { r, hash };
  });

  const exact = new Map<string, ExistingTx>();
  if (hashes.length) {
    const { rows: ex } = await pool.query('select * from transactions where import_hash = any($1::text[])', [hashes]);
    for (const t of ex) exact.set(t.import_hash, t);
  }
  const dates = rows.map((r) => r.date).filter((d): d is string => !!d).sort();
  let candidates: ExistingTx[] = [];
  if (dates.length) {
    const amounts = [...new Set(rows.map((r) => r.abs_cents))];
    const months = [...new Set(dates.map(monthOf))];
    // Itens datados: janela de ±5 dias. Itens sem data (ex.: contas previstas): mesmo mês de referência.
    const { rows: cand } = await pool.query(
      `select * from transactions
       where abs(total_cents) = any($1::bigint[])
         and (import_hash is null or not (import_hash = any($4::text[])))
         and ( coalesce(paid_on, occurred_on, due_date) between ($2::date - 5) and ($3::date + 5)
               or (coalesce(paid_on, occurred_on, due_date) is null and month_ref = any($5::text[])) )`,
      [amounts, dates[0], dates[dates.length - 1], hashes, months],
    );
    candidates = cand;
  }
  const used = new Set<number>();
  const target = { kind, id: targetId };
  const lowConfidence = pdfInfo?.confidence === 'low' || pdfInfo?.confidence === 'none';

  const out = withHash.map(({ r, hash }, idx) => {
    const sug = suggest({ description: r.description, direction: r.direction, kind, ownNames, rules });
    const category_id =
      sug.category_id ?? learned.get(normalizeText(r.description)) ??
      ((sug.category_slug ?? r.ai_category_slug) ? (catBySlug.get((sug.category_slug ?? r.ai_category_slug)!) ?? null) : null);
    let action: Action = sug.skip_by_default ? 'skip' : 'create';
    let duplicate: null | { level: 'exact' | 'possible'; id: number; description: string; date: string | null; status: string } = null;
    let note = sug.note;

    const ex = hash ? exact.get(hash) : undefined;
    if (ex) {
      duplicate = { level: 'exact', id: ex.id, description: ex.description, date: txDate(ex), status: ex.status };
      action = 'skip';
      note = 'Já importado antes (mesma data, valor e descrição).';
    } else if (r.date) {
      const p = findPossibleDuplicate({ date: r.date, abs_cents: r.abs_cents, direction: r.direction }, target, candidates, used);
      if (p) {
        duplicate = { level: 'possible', id: p.id, description: p.description, date: txDate(p), status: p.status };
        action = p.status === 'scheduled' ? 'link' : 'skip';
        note =
          p.status === 'scheduled'
            ? `Parece ser o lançamento já previsto "${p.description}". Vincular marca-o como pago sem duplicar.`
            : `Possível duplicata de "${p.description}" já cadastrado.`;
      }
    }
    // Linha ambígua (sem direção/data) ou de PDF pouco confiável nunca entra sozinha: o usuário precisa marcar.
    if (r.direction === null || r.date === null || lowConfidence) action = 'skip';

    return {
      idx,
      date: r.date,
      description: r.description,
      abs_cents: r.abs_cents,
      direction: r.direction,
      type: sug.type,
      category_id,
      learned: sug.learned ?? null,
      ai: !!r.ai,
      needs_review: sug.needs_review || !!r.uncertain_reason,
      note,
      uncertain_reason: r.uncertain_reason,
      action,
      duplicate,
      hash,
    };
  });

  // ----- Parcelamentos (só faturas de cartão) -----
  const withInstallment = out.map((o) => ({ ...o, installment: null as null | { no: number; total: number; bare: boolean } }));
  if (kind === 'card') {
    const infos = withInstallment.map((o) => (o.direction === 'out' ? detectInstallment(o.description) : null));
    const groups = infos.map((i) => (i ? installmentGroup(targetId, i.base, i.total) : null));
    const wanted = [...new Set(groups.filter((g): g is string => !!g))];
    const existing = new Map<string, ExistingTx & { is_projected: boolean; installment_no: number }>();
    if (wanted.length) {
      const { rows: ex } = await pool.query('select * from transactions where installment_group = any($1::text[])', [wanted]);
      for (const t of ex) existing.set(`${t.installment_group}:${t.installment_no}`, t);
    }
    withInstallment.forEach((o, i) => {
      const info = infos[i];
      if (!info) return;
      o.installment = { no: info.no, total: info.total, bare: info.bare };
      const ex = existing.get(`${groups[i]}:${info.no}`);
      if (ex && !ex.is_projected) {
        o.duplicate = { level: 'exact', id: ex.id, description: ex.description, date: txDate(ex), status: ex.status };
        o.action = 'skip';
        o.note = `A parcela ${info.no}/${info.total} desta compra já está lançada.`;
      } else if (ex) {
        o.duplicate = { level: 'possible', id: ex.id, description: ex.description, date: txDate(ex), status: ex.status };
        o.action = lowConfidence || !o.date ? 'skip' : 'link';
        o.note = `Parcela ${info.no}/${info.total} já prevista pelo sistema. Vincular confirma o valor real, sem duplicar.`;
      } else if (info.no < info.total) {
        const left = info.total - info.no;
        o.note = `Compra parcelada (${info.no}/${info.total}): as ${left} parcela(s) restante(s) serão previstas nas próximas faturas.${info.bare ? ' Confira se "' + info.no + '/' + info.total + '" é mesmo parcela.' : ''}`;
        if (info.bare) o.needs_review = true;
      }
    });
  }

  return {
    source_kind: sourceKind,
    target: { type: kind, id: targetId },
    skipped_lines: skipped,
    csv: csvInfo,
    pdf: pdfInfo,
    rows: withInstallment,
  };
}

async function commit(db: PoolClient, b: CommitBody) {
  const kind: TargetKind = b.target_type;
  let card: { id: number; name: string; closing_day: number; due_day: number } | null = null;
  if (kind === 'card') {
    const { rows } = await db.query('select id, name, closing_day, due_day from cards where id = $1', [b.target_id]);
    if (!rows[0]) throw badRequest('Cartão não encontrado.');
    card = rows[0];
  } else {
    const { rowCount } = await db.query('select 1 from accounts where id = $1', [b.target_id]);
    if (!rowCount) throw badRequest('Conta não encontrada.');
  }

  const active = b.rows.filter((r) => r.action !== 'skip');
  const label = b.label || `Importação de ${new Date().toLocaleDateString('pt-BR')} (${b.source_kind.toUpperCase()})`;
  const batch = await db.query(
    'insert into import_batches (label, source_kind, row_count) values ($1, $2, $3) returning id',
    [label, b.source_kind, active.length],
  );
  const batchId: number = batch.rows[0].id;

  // Fatura informada pelo usuário (ex.: vencimento lido na própria fatura) vale para todas as compras do arquivo.
  let forcedInvoice: number | null = null;
  if (card && b.invoice_due_date) {
    forcedInvoice = await findOrCreateInvoice(db, card.id, invoiceDatesForDue(card, b.invoice_due_date));
    if (b.statement_total_cents != null) {
      await db.query('update invoices set statement_total_cents = $2 where id = $1', [forcedInvoice, b.statement_total_cents]);
    }
  }

  let created = 0;
  let linked = 0;
  for (const r of b.rows) {
    if (r.action === 'skip') continue;
    if (card && r.type !== 'expense') throw badRequest('Em faturas de cartão só é possível importar compras e estornos.');
    if (['income', 'reimbursement'].includes(r.type) && r.direction !== 'in') throw badRequest(`"${r.description}": receitas e reembolsos devem ser entradas.`);
    if (['invoice_payment', 'overdraft_payment'].includes(r.type) && r.direction !== 'out') throw badRequest(`"${r.description}": pagamentos devem ser saídas.`);

    // Despesa com direção "entrada" é um estorno/crédito: valor negativo, abate o gasto.
    const signed = r.type === 'expense' && r.direction === 'in' ? -r.abs_cents : r.abs_cents;

    if (r.remember) await rememberRule(db, kind, r);

    if (r.action === 'link') {
      if (!r.link_to_id) throw badRequest('Escolha o lançamento a vincular.');
      await link(db, r, signed, kind, b.target_id, { forcedInvoice, batchId });
      linked++;
      continue;
    }

    const base = {
      type: r.type,
      description: r.description,
      category_id: ['expense', 'income'].includes(r.type) ? (r.category_id ?? null) : null,
      status: 'paid' as const,
      occurred_on: r.date,
      paid_on: card ? null : r.date,
      total_cents: signed,
      needs_review: r.needs_review ?? false,
      import_batch_id: batchId,
      import_hash: r.hash ?? null,
    };
    if (card) {
      const inst = r.direction === 'out' && r.type === 'expense' ? detectInstallment(r.description) : null;
      if (inst) {
        const outcome = await importInstallment(db, card, { ...base, description: r.description }, inst, forcedInvoice, r.date, signed);
        if (outcome === 'linked') linked++;
        else created++;
        continue;
      }
      await createTransaction(db, { ...base, card_id: card.id, ...(forcedInvoice ? { invoice_id: forcedInvoice } : {}) });
    } else if (r.type === 'transfer') {
      if (r.transfer_account_id === b.target_id) throw badRequest('Origem e destino da transferência são a mesma conta.');
      await createTransaction(db, {
        ...base,
        account_id: r.direction === 'out' ? b.target_id : (r.transfer_account_id ?? null),
        transfer_account_id: r.direction === 'out' ? (r.transfer_account_id ?? null) : b.target_id,
      });
    } else if (r.type === 'invoice_payment') {
      const invoiceId = await matchInvoice(db, r.card_id ?? null, r.abs_cents, r.date);
      await createTransaction(db, {
        ...base,
        account_id: b.target_id,
        card_id: r.card_id ?? null,
        invoice_id: invoiceId,
        needs_review: (r.needs_review ?? false) || invoiceId === null,
        review_note: invoiceId === null ? 'Pagamento de fatura sem fatura vinculada. Vincule na tela Cartões e faturas.' : null,
      });
    } else {
      await createTransaction(db, { ...base, account_id: b.target_id });
    }
    created++;
  }

  if (created + linked === 0) {
    await db.query('delete from import_batches where id = $1', [batchId]);
    return { batch_id: null, created, linked, skipped: b.rows.length };
  }
  await db.query('update import_batches set row_count = $2 where id = $1', [batchId, created + linked]);
  return { batch_id: batchId, created, linked, skipped: b.rows.length - created - linked };
}

/** Grava (ou reforça) a regra do estabelecimento. Só guarda o nome normalizado, a categoria e o tipo. */
async function rememberRule(db: Queryable, kind: TargetKind, r: CommitRow) {
  const pattern = merchantKey(r.description);
  if (!pattern) return;
  const categoryId = ['expense', 'income'].includes(r.type) ? (r.category_id ?? null) : null;
  await db.query(
    `insert into learned_rules (kind, pattern, category_id, type) values ($1, $2, $3, $4)
     on conflict (kind, pattern) do update
       set category_id = excluded.category_id, type = excluded.type,
           use_count = learned_rules.use_count + 1, last_used_at = now()`,
    [kind, pattern, categoryId, r.type],
  );
}

/** Fatura em aberto do cartão cujo valor bate exatamente com o pagamento (mais próxima da data). */
async function matchInvoice(db: Queryable, cardId: number | null, cents: number, date: string): Promise<number | null> {
  if (!cardId) return null;
  const { rows } = await db.query(
    `select i.id from invoices i
     where i.card_id = $1 and i.paid_on is null
       and coalesce(i.statement_total_cents, (select sum(t.total_cents) from transactions t where t.invoice_id = i.id and t.type = 'expense'), 0) = $2
     order by abs(i.due_date - $3::date) limit 1`,
    [cardId, cents, date],
  );
  return rows[0]?.id ?? null;
}

/** Compra parcelada numa fatura: cria a parcela real e projeta as restantes, ou confirma a que já estava prevista. */
async function importInstallment(
  db: PoolClient,
  card: { id: number; closing_day: number; due_day: number },
  base: Parameters<typeof createTransaction>[1],
  inst: NonNullable<ReturnType<typeof detectInstallment>>,
  forcedInvoice: number | null,
  date: string,
  signed: number,
): Promise<'created' | 'linked'> {
  const group = installmentGroup(card.id, inst.base, inst.total);
  const { rows } = await db.query('select id, is_projected from transactions where installment_group = $1 and installment_no = $2', [group, inst.no]);
  const ex = rows[0];
  if (ex?.is_projected) {
    await confirmProjectedInstallment(db, ex.id, {
      date, description: base.description, signed_cents: signed, hash: base.import_hash ?? null, batch_id: base.import_batch_id ?? null,
      forced_invoice_id: forcedInvoice,
    });
    await syncInvoicePaid(db, forcedInvoice);
    return 'linked';
  }

  let occurred = date;
  let reviewNote: string | null = null;
  if (forcedInvoice && inst.no > 1) {
    const { rows: inv } = await db.query('select closing_date from invoices where id = $1', [forcedInvoice]);
    occurred = dateInInvoiceCycle(card, inv[0]?.closing_date ?? null, date);
    if (occurred !== date) reviewNote = `Parcela de compra feita em ${date.split('-').reverse().join('/')}; lançada na data de fechamento da fatura.`;
  } else if (inst.no > 1) {
    reviewNote = 'Parcela de compra antiga: informe o vencimento da fatura na importação para ela cair na fatura certa.';
  }
  const duplicateReal = !!ex; // a mesma parcela já existe: registra como compra comum, sem projetar
  const tx = await createTransaction(db, {
    ...base,
    card_id: card.id,
    occurred_on: occurred,
    ...(forcedInvoice ? { invoice_id: forcedInvoice } : {}),
    ...(duplicateReal
      ? { needs_review: true, review_note: `A parcela ${inst.no}/${inst.total} já estava lançada; esta linha foi registrada sem parcelamento.` }
      : { installment_no: inst.no, installment_total: inst.total, installment_group: group, needs_review: base.needs_review || !!reviewNote || inst.bare, review_note: reviewNote }),
  });
  if (!duplicateReal) await projectInstallments(db, tx.id);
  return 'created';
}

/** Vincula a linha importada a um lançamento previsto: marca como pago, sem criar outro. */
async function link(
  db: Queryable, r: CommitRow, signed: number, kind: TargetKind, targetId: number,
  ctx: { forcedInvoice: number | null; batchId: number },
) {
  const { rows } = await db.query('select * from transactions where id = $1', [r.link_to_id]);
  const ex = rows[0];
  if (!ex) throw badRequest('Lançamento a vincular não encontrado.');
  if (ex.is_projected) {
    // Parcela prevista pelo sistema: confirma com o valor, data e descrição reais da fatura.
    await confirmProjectedInstallment(db, ex.id, {
      date: r.date, description: r.description, signed_cents: signed, hash: r.hash ?? null, batch_id: ctx.batchId,
      forced_invoice_id: ctx.forcedInvoice,
    });
    await syncInvoicePaid(db, ex.invoice_id);
    return;
  }
  const patch: Record<string, unknown> = {
    status: 'paid',
    paid_on: kind === 'card' ? null : r.date,
    occurred_on: r.date,
    date_confirmed: true,
    is_estimate: false,
    import_hash: r.hash ?? null,
  };
  if (ex.type === 'income' && ex.gross_cents !== null) {
    // O valor real recebido revela os descontos reais: líquido = bruto − descontos.
    patch.deductions_cents = ex.gross_cents - Math.abs(signed);
  } else if (ex.type === 'expense') {
    const wasUnshared = ex.my_share_cents === null || ex.my_share_cents === ex.total_cents;
    patch.total_cents = signed;
    if (wasUnshared) patch.my_share_cents = signed;
  } else {
    patch.total_cents = Math.abs(signed);
  }
  if (kind === 'account' && ex.account_id === null && ex.type !== 'transfer') patch.account_id = targetId;
  if (ex.type === 'transfer') {
    if (ex.account_id === null && r.direction === 'out') patch.account_id = targetId;
    if (ex.transfer_account_id === null && r.direction === 'in') patch.transfer_account_id = targetId;
  }
  await updateTransaction(db, ex.id, patch as never);
  // Mantém o vínculo com a importação para que "apagar importação" não deixe hash órfão.
  await db.query('update transactions set import_hash = $2 where id = $1', [ex.id, r.hash ?? null]);
  await syncInvoicePaid(db, ex.invoice_id);
}
