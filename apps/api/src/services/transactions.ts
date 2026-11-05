import { z } from 'zod';
import type { Queryable } from '../db.js';
import { badRequest, notFound } from '../errors.js';
import { MONTH_RE, isValidDate, monthOf } from '../lib.js';
import { invoiceForPurchase, syncInvoicePaid } from './invoices.js';

const date = z.string().refine(isValidDate, 'Data inválida (use AAAA-MM-DD).');
const cents = z.number().int().min(-99_999_999_999).max(99_999_999_999);
const optId = z.number().int().positive().nullable().optional();
const optText = (max: number) => z.string().trim().max(max).nullable().optional();

export const txTypes = ['income', 'expense', 'transfer', 'reimbursement', 'invoice_payment', 'overdraft_payment'] as const;

export const txInputSchema = z.object({
  type: z.enum(txTypes),
  description: z.string().trim().min(1, 'Informe uma descrição.').max(200),
  category_id: optId,
  account_id: optId,
  transfer_account_id: optId,
  card_id: optId,
  invoice_id: optId,
  status: z.enum(['paid', 'scheduled']).optional(),
  month_ref: z.string().regex(MONTH_RE).nullable().optional(),
  occurred_on: date.nullable().optional(),
  due_date: date.nullable().optional(),
  paid_on: date.nullable().optional(),
  date_confirmed: z.boolean().optional(),
  total_cents: cents,
  my_share_cents: cents.nullable().optional(),
  gross_cents: cents.nullable().optional(),
  deductions_cents: cents.nullable().optional(),
  shared_with: optText(200),
  reimbursement_for_id: optId,
  is_estimate: z.boolean().optional(),
  needs_review: z.boolean().optional(),
  review_note: optText(500),
  notes: optText(1000),
  recurring_id: optId,
  import_batch_id: optId,
  import_hash: z.string().max(100).nullable().optional(),
  // Parcelamento de cartão. O grupo e a marca de "projetada" são controlados só pelo servidor.
  installment_no: z.number().int().min(1).max(120).nullable().optional(),
  installment_total: z.number().int().min(2).max(120).nullable().optional(),
  installment_group: z.string().max(40).nullable().optional(),
  is_projected: z.boolean().optional(),
  manually_edited: z.boolean().optional(),
});

const SERVER_ONLY = { installment_group: true, is_projected: true, manually_edited: true, import_batch_id: true, import_hash: true, recurring_id: true } as const;
/** Entrada vinda da interface (POST): sem campos controlados pelo servidor. */
export const txCreateSchema = txInputSchema.omit(SERVER_ONLY);
/** Edição (PATCH): o parcelamento não pode ser trocado por aqui. */
export const txPatchSchema = txInputSchema.omit({ ...SERVER_ONLY, installment_no: true, installment_total: true }).partial();
export type TxInput = z.infer<typeof txInputSchema>;

export const TX_SELECT = `
  select t.*, c.name as category_name, c.slug as category_slug,
         a.name as account_name, ta.name as transfer_account_name, cd.name as card_name
  from transactions t
  left join categories c on c.id = t.category_id
  left join accounts a on a.id = t.account_id
  left join accounts ta on ta.id = t.transfer_account_id
  left join cards cd on cd.id = t.card_id`;

const COLUMNS = [
  'type', 'description', 'category_id', 'account_id', 'transfer_account_id', 'card_id', 'invoice_id', 'status',
  'month_ref', 'occurred_on', 'due_date', 'paid_on', 'date_confirmed', 'total_cents', 'my_share_cents',
  'gross_cents', 'deductions_cents', 'shared_with', 'reimbursement_for_id', 'is_estimate', 'needs_review',
  'review_note', 'notes', 'recurring_id', 'import_batch_id', 'import_hash',
  'installment_no', 'installment_total', 'installment_group', 'is_projected', 'manually_edited',
] as const;

type Full = Record<(typeof COLUMNS)[number], any>;

/** Aplica as regras financeiras e devolve a linha completa pronta para gravar. */
async function normalize(db: Queryable, merged: Partial<Full>, touched: Set<string>): Promise<Full> {
  const t = merged as Full;
  const out: Full = {
    type: t.type,
    description: t.description,
    category_id: t.category_id ?? null,
    account_id: t.account_id ?? null,
    transfer_account_id: t.transfer_account_id ?? null,
    card_id: t.card_id ?? null,
    invoice_id: t.invoice_id ?? null,
    status: t.status ?? 'paid',
    month_ref: t.month_ref ?? null,
    occurred_on: t.occurred_on ?? null,
    due_date: t.due_date ?? null,
    paid_on: t.paid_on ?? null,
    date_confirmed: t.date_confirmed ?? true,
    total_cents: t.total_cents,
    my_share_cents: t.my_share_cents ?? null,
    gross_cents: t.gross_cents ?? null,
    deductions_cents: t.deductions_cents ?? null,
    shared_with: t.shared_with?.trim() || null,
    reimbursement_for_id: t.reimbursement_for_id ?? null,
    is_estimate: t.is_estimate ?? false,
    needs_review: t.needs_review ?? false,
    review_note: t.review_note?.trim() || null,
    notes: t.notes?.trim() || null,
    recurring_id: t.recurring_id ?? null,
    import_batch_id: t.import_batch_id ?? null,
    import_hash: t.import_hash ?? null,
    installment_no: t.installment_no ?? null,
    installment_total: t.installment_total ?? null,
    installment_group: t.installment_group ?? null,
    is_projected: t.is_projected ?? false,
    manually_edited: t.manually_edited ?? false,
  };

  switch (out.type) {
    case 'income':
      if (out.gross_cents !== null) out.total_cents = out.gross_cents - (out.deductions_cents ?? 0); // líquido = bruto − descontos
      out.my_share_cents = null;
      out.card_id = null;
      out.invoice_id = null;
      break;
    case 'expense':
      if (out.my_share_cents === null) out.my_share_cents = out.total_cents;
      if (out.total_cents >= 0 && (out.my_share_cents < 0 || out.my_share_cents > out.total_cents)) {
        throw badRequest('Minha parte deve estar entre zero e o valor total.');
      }
      out.gross_cents = null;
      out.deductions_cents = null;
      if (out.card_id !== null) out.account_id = null; // compra no cartão não sai da conta agora
      break;
    case 'transfer':
      if (out.total_cents <= 0) throw badRequest('O valor da transferência deve ser positivo.');
      if (out.account_id === null && out.transfer_account_id === null) throw badRequest('Informe ao menos uma das contas da transferência.');
      if (out.account_id === out.transfer_account_id) throw badRequest('Origem e destino da transferência devem ser contas diferentes.');
      Object.assign(out, { my_share_cents: null, category_id: null, card_id: null, invoice_id: null, gross_cents: null, deductions_cents: null });
      break;
    case 'reimbursement':
      if (out.total_cents <= 0) throw badRequest('O valor do reembolso deve ser positivo.');
      Object.assign(out, { my_share_cents: null, card_id: null, invoice_id: null, gross_cents: null, deductions_cents: null });
      break;
    case 'invoice_payment':
      if (out.total_cents <= 0) throw badRequest('O valor do pagamento deve ser positivo.');
      Object.assign(out, { my_share_cents: null, category_id: null, gross_cents: null, deductions_cents: null });
      if (out.invoice_id !== null) {
        const { rows } = await db.query('select card_id from invoices where id = $1', [out.invoice_id]);
        if (!rows[0]) throw badRequest('Fatura não encontrada.');
        out.card_id = rows[0].card_id;
      }
      break;
    case 'overdraft_payment':
      if (out.total_cents <= 0) throw badRequest('O valor do pagamento deve ser positivo.');
      if (out.account_id === null) throw badRequest('Informe a conta com cheque especial.');
      Object.assign(out, { my_share_cents: null, category_id: null, card_id: null, invoice_id: null, gross_cents: null, deductions_cents: null });
      break;
  }

  // Parcelamento só existe em compras de cartão.
  if (!(out.type === 'expense' && out.card_id !== null)) {
    Object.assign(out, { installment_no: null, installment_total: null, installment_group: null, is_projected: false });
  } else if (out.installment_total !== null) {
    out.installment_no ??= 1;
    if (out.installment_no > out.installment_total) throw badRequest('A parcela atual não pode ser maior que o total de parcelas.');
  } else {
    Object.assign(out, { installment_no: null, installment_group: null, is_projected: false });
  }

  if (out.type !== 'expense' && out.type !== 'income') out.shared_with = out.type === 'reimbursement' ? out.shared_with : null;
  if (out.type !== 'reimbursement') out.reimbursement_for_id = null;
  else if (out.reimbursement_for_id !== null) {
    const { rows } = await db.query('select type from transactions where id = $1', [out.reimbursement_for_id]);
    if (!rows[0] || rows[0].type !== 'expense') throw badRequest('O reembolso deve se referir a uma despesa.');
  }

  // Datas: pago → data do pagamento (padrão: data da compra/vencimento); agendado → sem data de pagamento.
  const isCardPurchase = out.type === 'expense' && out.card_id !== null;
  if (out.status === 'scheduled') out.paid_on = null;
  else if (!isCardPurchase && out.paid_on === null) out.paid_on = out.occurred_on ?? out.due_date;
  if (isCardPurchase) out.paid_on = null; // a saída de caixa é o pagamento da fatura

  const datesChanged = ['occurred_on', 'due_date', 'paid_on'].some((k) => touched.has(k)) && !touched.has('month_ref');
  const needsMonth = !out.month_ref || datesChanged;
  if (needsMonth) {
    const base = out.occurred_on ?? out.due_date ?? out.paid_on;
    if (base) out.month_ref = monthOf(base);
  }
  if (!out.month_ref) throw badRequest('Informe uma data ou o mês de referência.');

  if (isCardPurchase) {
    if (!out.occurred_on) throw badRequest('Informe a data da compra no cartão.');
    // Fatura escolhida explicitamente é mantida; senão deriva do fechamento do cartão.
    const explicitInvoice = touched.has('invoice_id') && out.invoice_id !== null;
    if (!explicitInvoice && (out.invoice_id === null || touched.has('card_id') || touched.has('occurred_on'))) {
      out.invoice_id = await invoiceForPurchase(db, out.card_id, out.occurred_on);
    }
  }
  if (out.type === 'expense' && out.card_id === null) out.invoice_id = null;

  await assertRefs(db, out);
  return out;
}

async function assertRefs(db: Queryable, t: Full) {
  const checks: [string, string, number | null][] = [
    ['categories', 'Categoria', t.category_id],
    ['accounts', 'Conta', t.account_id],
    ['accounts', 'Conta de destino', t.transfer_account_id],
    ['cards', 'Cartão', t.card_id],
  ];
  for (const [table, label, id] of checks) {
    if (id === null) continue;
    const { rowCount } = await db.query(`select 1 from ${table} where id = $1`, [id]);
    if (!rowCount) throw badRequest(`${label} não encontrado(a).`);
  }
}

export async function createTransaction(db: Queryable, input: TxInput) {
  const touched = new Set(Object.keys(input));
  const row = await normalize(db, input as Partial<Full>, touched);
  const values = COLUMNS.map((c) => row[c]);
  const { rows } = await db.query(
    `insert into transactions (${COLUMNS.join(', ')}) values (${COLUMNS.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
    values,
  );
  if (row.type === 'invoice_payment') await syncInvoicePaid(db, row.invoice_id);
  return getTransaction(db, rows[0].id);
}

// Campos cuja mudança conta como "edição manual" de um lançamento gerado por recorrência.
const CONTENT_FIELDS = [
  'description', 'total_cents', 'my_share_cents', 'gross_cents', 'deductions_cents', 'category_id', 'account_id',
  'due_date', 'occurred_on', 'shared_with',
];

export async function updateTransaction(db: Queryable, id: number, patch: Partial<TxInput>, opts: { manual?: boolean } = {}) {
  const { rows: existing } = await db.query('select * from transactions where id = $1', [id]);
  if (!existing[0]) throw notFound();
  const merged = { ...existing[0], ...patch };
  // Só considera "alterado" o que de fato mudou de valor (o formulário envia todos os campos).
  const touched = new Set(
    Object.entries(patch)
      .filter(([k, v]) => (v ?? null) !== ((existing[0] as Record<string, unknown>)[k] ?? null))
      .map(([k]) => k),
  );
  if (opts.manual && existing[0].recurring_id && CONTENT_FIELDS.some((k) => touched.has(k))) merged.manually_edited = true;
  const row = await normalize(db, merged, touched);
  const sets = COLUMNS.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await db.query(`update transactions set ${sets}, updated_at = now() where id = $1`, [id, ...COLUMNS.map((c) => row[c])]);
  await syncInvoicePaid(db, existing[0].invoice_id);
  await syncInvoicePaid(db, row.invoice_id);
  return getTransaction(db, id);
}

export async function deleteTransaction(db: Queryable, id: number) {
  const { rows } = await db.query('delete from transactions where id = $1 returning invoice_id, recurring_id, month_ref', [id]);
  if (!rows[0]) throw notFound();
  if (rows[0].recurring_id) {
    await db.query('insert into recurring_skips (recurring_id, month_ref) values ($1, $2) on conflict do nothing', [
      rows[0].recurring_id,
      rows[0].month_ref,
    ]);
  }
  await syncInvoicePaid(db, rows[0].invoice_id);
}

export async function getTransaction(db: Queryable, id: number) {
  const { rows } = await db.query(`${TX_SELECT} where t.id = $1`, [id]);
  if (!rows[0]) throw notFound();
  return rows[0];
}
