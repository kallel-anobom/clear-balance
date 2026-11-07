import { getAccessToken } from './supabase';

export class ApiError extends Error {
  constructor(message: string, public status = 0) {
    super(message);
  }
}

/** Mensagem clara para quem usa; o servidor nunca devolve conteúdo de extratos nos erros. */
function friendly(status: number, serverMessage?: string): string {
  if (status === 401) return 'Sua sessão expirou. Clique em Sair e entre de novo.';
  if (status === 403) return serverMessage ?? 'Este usuário não tem permissão (e-mail fora da lista permitida ou verificação em duas etapas pendente).';
  if (status === 413) return serverMessage ?? 'O arquivo ou texto é grande demais. Envie menos imagens por vez.';
  if (status === 429) return 'Muitas requisições em pouco tempo. Aguarde um minuto e tente de novo.';
  if (status === 504 || status === 502 || status === 503) return `O servidor demorou a responder (erro ${status}). Tente de novo com menos imagens ou mais tarde.`;
  if (status >= 500) return serverMessage ?? `O servidor falhou (erro ${status}). Tente de novo; se continuar, veja os logs da função no Vercel.`;
  return serverMessage ?? `Erro ${status}`;
}

async function send(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new ApiError('Não consegui falar com o servidor. Verifique sua internet e tente de novo.', 0);
  }
}

async function authHeader(): Promise<Record<string, string>> {
  const token = await getAccessToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await send(`/api${url}`, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(await authHeader()) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(friendly(res.status, data?.error), res.status);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body ?? {}),
  put: <T>(url: string, body: unknown) => request<T>('PUT', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  del: <T = void>(url: string) => request<T>('DELETE', url),
  async upload<T>(url: string, form: FormData): Promise<T> {
    const res = await send(`/api${url}`, { method: 'POST', body: form, headers: await authHeader() });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(friendly(res.status, data?.error), res.status);
    return data as T;
  },
};

export const qs = (params: Record<string, string | number | boolean | undefined | null>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

// ---------- Tipos ----------
export type TxType = 'income' | 'expense' | 'transfer' | 'reimbursement' | 'invoice_payment' | 'overdraft_payment';

export interface Account {
  id: number; name: string; kind: 'checking' | 'savings' | 'cash' | 'investment';
  balance_cents: number | null; balance_date: string | null; overdraft_limit_cents: number | null;
}
export interface Card {
  id: number; name: string; last4: string | null; closing_day: number; due_day: number; default_account_id: number | null;
}
export interface Category { id: number; slug: string; name: string; kind: 'expense' | 'income' }

export interface Tx {
  id: number; type: TxType; description: string;
  category_id: number | null; category_name: string | null;
  account_id: number | null; account_name: string | null;
  transfer_account_id: number | null; transfer_account_name: string | null;
  card_id: number | null; card_name: string | null; invoice_id: number | null;
  status: 'paid' | 'scheduled'; month_ref: string;
  occurred_on: string | null; due_date: string | null; paid_on: string | null; date_confirmed: boolean;
  total_cents: number; my_share_cents: number | null; gross_cents: number | null; deductions_cents: number | null;
  shared_with: string | null; reimbursement_for_id: number | null;
  is_estimate: boolean; needs_review: boolean; review_note: string | null; notes: string | null;
  recurring_id: number | null; import_batch_id: number | null;
  installment_no: number | null; installment_total: number | null; installment_group: string | null; is_projected: boolean;
  manually_edited: boolean;
  others_cents: number; reimbursed_cents: number;
}

export interface Invoice {
  id: number; card_id: number; card_name: string; card_last4: string | null;
  closing_date: string | null; due_date: string; paid_on: string | null;
  statement_total_cents: number | null; lines_total_cents: number; lines_mine_cents: number; lines_count: number;
  amount_cents: number; amount_estimated: boolean; status: 'open' | 'closed' | 'paid'; overdue: boolean;
  mismatch_cents: number | null;
}
export interface InvoiceDetail extends Invoice { purchases: Tx[]; payments: Tx[] }

export interface Recurring {
  id: number; description: string; type: 'expense' | 'income'; category_id: number | null; category_name: string | null;
  account_id: number | null; frequency: 'monthly' | 'yearly'; day_of_month: number | null; month_of_year: number | null;
  start_month: string | null; end_month: string | null; total_cents: number; my_share_cents: number | null;
  gross_cents: number | null; deductions_cents: number | null; shared_with: string | null;
  is_estimate: boolean; needs_review: boolean; review_note: string | null; notes: string | null; active: boolean;
}

export interface FlowItem {
  key: string; kind: 'conta' | 'fatura' | 'cheque_especial'; label: string; date: string | null; amount_cents: number;
  status: 'paid' | 'pending'; estimated: boolean; date_confirmed: boolean; overdue: boolean;
  tx_id: number | null; invoice_id: number | null;
}

export interface Overview {
  month: string; today: string;
  spending: {
    realized_mine_cents: number; realized_total_cents: number; planned_mine_cents: number; planned_total_cents: number;
    planned_estimated_count: number; by_category: { name: string; realized_cents: number; planned_cents: number }[];
    /** Custo total do mês (competência, minha parte): já pago + ainda previsto. */
    total_mine_cents: number; estimated_count: number;
    breakdown: { key: string; label: string; hint: string; count: number; paid_cents: number; planned_cents: number; total_cents: number; projected_count: number }[];
    excluded: { code: string; label: string; count: number; amount_cents: number; reason: string }[];
  };
  income: {
    received_net_cents: number; scheduled_net_cents: number; gross_cents: number; deductions_cents: number; net_cents: number;
    items: { id: number; description: string; date: string | null; date_confirmed: boolean; status: 'paid' | 'scheduled';
      gross_cents: number | null; deductions_cents: number | null; net_cents: number; estimated: boolean }[];
  };
  cash: { paid_cents: number; pending_cents: number; total_cents: number; items: FlowItem[] };
  upcoming: FlowItem[];
  reimbursements: {
    pending_month_cents: number; pending_all_cents: number; received_in_month_cents: number;
    items: { id: number; description: string; month_ref: string; shared_with: string | null; others_cents: number; received_cents: number; pending_cents: number }[];
  };
  overdraft: {
    debt_cents: number; costs_in_month_cents: number; amortized_in_month_cents: number;
    accounts: { id: number; name: string; debt_cents: number; limit_cents: number | null; balance_date: string | null }[];
  };
  forecast: {
    is_current_month: boolean; current_balance_cents: number | null; accounts_without_balance: string[]; balance_date: string | null;
    pending_inflows_cents: number; pending_outflows_cents: number;
    projected_balance_cents: number | null; projected_with_reimbursements_cents: number | null;
    month_result_cents: number; month_result_with_reimbursements_cents: number;
    has_estimates: boolean; has_unconfirmed_dates: boolean;
  };
  attention: { code: string; text: string; count: number }[];
  yearly_without_month: string[];
  installments: { in_month_cents: number; in_month_count: number; remaining_cents: number; remaining_count: number; last_month: string | null };
}

export interface InstallmentGroup {
  group: string; card_id: number; card_name: string; description: string; total: number; last_real_no: number | null;
  remaining_count: number; remaining_mine_cents: number; remaining_total_cents: number;
  next_month: string | null; last_month: string | null; installment_mine_cents: number;
}
export interface InstallmentsResponse {
  groups: InstallmentGroup[]; by_month: { month: string; mine_cents: number; count: number }[]; remaining_mine_cents: number;
}

export interface PreviewRow {
  idx: number; date: string | null; description: string; abs_cents: number; direction: 'in' | 'out' | null;
  type: TxType; category_id: number | null; needs_review: boolean; note: string | null; uncertain_reason: string | null;
  action: 'create' | 'skip' | 'link'; hash: string | null;
  duplicate: null | { level: 'exact' | 'possible'; id: number; description: string; date: string | null; status: string };
  // preenchidos na tela
  transfer_account_id?: number | null; card_id?: number | null;
  installment?: { no: number; total: number; bare: boolean } | null;
}
export interface PreviewResponse {
  source_kind: 'csv' | 'pdf' | 'image';
  target: { type: 'account' | 'card'; id: number };
  skipped_lines: number;
  csv: null | { headers: string[]; sample: string[][]; mapping: Record<string, number>; needs_mapping: boolean };
  pdf: null | {
    confidence: 'ok' | 'low' | 'none'; candidate_lines: number; parsed_lines: number;
    detected_due_date: string | null; detected_total_cents: number | null; reconciliation_cents: number | null; warnings: string[];
    stats?: { lines: number; lines_with_money: number; date_headers: number; reader: 'classic' | 'app' };
  };
  rows: PreviewRow[];
}
