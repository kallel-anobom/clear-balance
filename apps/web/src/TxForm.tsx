import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, qs, type Invoice, type Tx, type TxType } from './api';
import { ErrorBox, Field, Modal, MoneyField } from './components';
import { TYPE_LABEL, brl, monthShort, todayISO } from './format';
import { useLookups, useRefresh } from './hooks';

interface FormState {
  type: TxType; description: string; status: 'paid' | 'scheduled';
  category_id: number | null; where: 'account' | 'card';
  account_id: number | null; transfer_account_id: number | null; card_id: number | null; invoice_id: number | null;
  occurred_on: string; due_date: string; paid_on: string; month_ref: string; date_confirmed: boolean;
  total: number | null; mine: number | null; shared_with: string; gross: number | null; deductions: number | null;
  is_estimate: boolean; needs_review: boolean; review_note: string; notes: string; reimbursement_for_id: number | null;
  inst_no: string; inst_total: string; apply_following: boolean;
}

export type TxPreset = Partial<FormState>;

function fromTx(t: Tx): FormState {
  return {
    type: t.type, description: t.description, status: t.status, category_id: t.category_id,
    where: t.card_id ? 'card' : 'account', account_id: t.account_id, transfer_account_id: t.transfer_account_id,
    card_id: t.card_id, invoice_id: t.invoice_id, occurred_on: t.occurred_on ?? '', due_date: t.due_date ?? '',
    paid_on: t.paid_on ?? '', month_ref: t.month_ref, date_confirmed: t.date_confirmed,
    total: t.total_cents, mine: t.my_share_cents, shared_with: t.shared_with ?? '',
    gross: t.gross_cents, deductions: t.deductions_cents, is_estimate: t.is_estimate, needs_review: t.needs_review,
    review_note: t.review_note ?? '', notes: t.notes ?? '', reimbursement_for_id: t.reimbursement_for_id,
    inst_no: t.installment_no ? String(t.installment_no) : '', inst_total: t.installment_total ? String(t.installment_total) : '', apply_following: false,
  };
}

const blank = (month: string): FormState => ({
  type: 'expense', description: '', status: 'paid', category_id: null, where: 'account', account_id: null,
  transfer_account_id: null, card_id: null, invoice_id: null, occurred_on: todayISO(), due_date: '', paid_on: '',
  month_ref: month, date_confirmed: true, total: null, mine: null, shared_with: '', gross: null, deductions: null,
  is_estimate: false, needs_review: false, review_note: '', notes: '', reimbursement_for_id: null,
  inst_no: '', inst_total: '', apply_following: false,
});

export function TxForm({ tx, preset, month, onClose, title }: { tx?: Tx; preset?: TxPreset; month: string; onClose: () => void; title?: string }) {
  const { accounts, cards, categories } = useLookups();
  const refresh = useRefresh();
  const [f, setF] = useState<FormState>(() => (tx ? fromTx(tx) : { ...blank(month), ...preset }));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setF((s) => ({ ...s, [k]: v }));

  const isExpense = f.type === 'expense';
  const isIncome = f.type === 'income';
  const isCardPurchase = isExpense && f.where === 'card';
  const singleDate = ['transfer', 'reimbursement', 'invoice_payment', 'overdraft_payment'].includes(f.type);
  const netIncome = isIncome && f.gross !== null ? f.gross - (f.deductions ?? 0) : f.total;

  const invoices = useQuery({
    queryKey: ['invoices', f.card_id],
    queryFn: () => api.get<{ invoices: Invoice[] }>(`/invoices${qs({ card_id: f.card_id })}`),
    enabled: f.type === 'invoice_payment' && !!f.card_id,
  });
  const shared = useQuery({
    queryKey: ['shared-expenses'],
    queryFn: () => api.get<Tx[]>(`/transactions${qs({ type: 'expense' })}`),
    enabled: f.type === 'reimbursement',
  });

  const save = useMutation({
    mutationFn: async () => {
      const total = isIncome ? netIncome : f.total;
      if (total === null || (!isIncome && f.type !== 'expense' && total <= 0)) throw new Error('Informe o valor.');
      if (!f.description.trim()) throw new Error('Informe uma descrição.');
      const dateVal = f.occurred_on || f.paid_on || f.due_date;
      const p: Record<string, unknown> = {
        type: f.type, description: f.description.trim(), status: f.status,
        total_cents: total, is_estimate: f.is_estimate, needs_review: f.needs_review,
        review_note: f.review_note || null, notes: f.notes || null,
      };
      if (isExpense || isIncome) p.category_id = f.category_id;
      if (singleDate) {
        // Uma data só: se pago, é a data do pagamento; se previsto, é o vencimento.
        p.occurred_on = f.status === 'paid' ? dateVal || null : null;
        p.paid_on = f.status === 'paid' ? dateVal || null : null;
        p.due_date = f.status === 'scheduled' ? dateVal || null : null;
      } else {
        p.occurred_on = f.occurred_on || null;
        p.due_date = f.due_date || null;
        p.paid_on = f.status === 'paid' && !isCardPurchase ? f.paid_on || null : null;
      }
      const anyDate = p.occurred_on || p.due_date || p.paid_on;
      if (!anyDate) p.month_ref = f.month_ref;
      p.date_confirmed = f.status === 'scheduled' ? !!anyDate && f.date_confirmed : true;
      if (isExpense) {
        p.my_share_cents = f.mine ?? total;
        p.shared_with = f.shared_with || null;
        if (isCardPurchase) { p.card_id = f.card_id; p.account_id = null; if (!f.card_id) throw new Error('Escolha o cartão.'); }
        else { p.account_id = f.account_id; p.card_id = null; }
      }
      if (isIncome) {
        p.account_id = f.account_id;
        p.gross_cents = f.gross;
        p.deductions_cents = f.gross !== null ? (f.deductions ?? 0) : null;
      }
      if (f.type === 'transfer') { p.account_id = f.account_id; p.transfer_account_id = f.transfer_account_id; }
      if (f.type === 'reimbursement') { p.account_id = f.account_id; p.reimbursement_for_id = f.reimbursement_for_id; p.shared_with = f.shared_with || null; }
      if (f.type === 'invoice_payment') { p.account_id = f.account_id; p.card_id = f.card_id; p.invoice_id = f.invoice_id; }
      if (f.type === 'overdraft_payment') p.account_id = f.account_id;
      if (!tx && isCardPurchase && f.inst_total) {
        const total_n = Number(f.inst_total);
        const no = f.inst_no ? Number(f.inst_no) : 1;
        if (!Number.isInteger(total_n) || total_n < 2 || total_n > 120) throw new Error('Total de parcelas deve ser entre 2 e 120.');
        if (!Number.isInteger(no) || no < 1 || no > total_n) throw new Error('A parcela atual deve estar entre 1 e o total de parcelas.');
        p.installment_total = total_n;
        p.installment_no = no;
      }
      if (tx) return api.patch(`/transactions/${tx.id}${f.apply_following && tx.installment_group ? '?scope=following' : ''}`, p);
      return api.post('/transactions', p);
    },
    onSuccess: () => { refresh(); onClose(); },
  });

  const accountSelect = (label: string, key: 'account_id' | 'transfer_account_id', required = false) => (
    <Field label={label}>
      <select value={f[key] ?? ''} required={required} onChange={(e) => set(key, e.target.value ? Number(e.target.value) : null)}>
        <option value="">{required ? 'Escolha…' : 'Não informada'}</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
      </select>
    </Field>
  );

  return (
    <Modal title={title ?? (tx ? 'Editar lançamento' : 'Novo lançamento')} onClose={onClose} wide>
      <form
        className="form-grid"
        onSubmit={(e) => { e.preventDefault(); save.mutate(); }}
      >
        <Field label="Tipo">
          <select value={f.type} onChange={(e) => set('type', e.target.value as TxType)}>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Situação">
          <select value={f.status} onChange={(e) => set('status', e.target.value as 'paid' | 'scheduled')}>
            <option value="paid">{isIncome ? 'Recebido' : isCardPurchase ? 'Compra realizada' : 'Pago / realizado'}</option>
            <option value="scheduled">{isIncome ? 'A receber (previsto)' : 'A pagar (previsto)'}</option>
          </select>
        </Field>
        <Field label="Descrição" className="span2">
          <input value={f.description} onChange={(e) => set('description', e.target.value)} required maxLength={200} autoFocus />
        </Field>

        {(isExpense || isIncome) && (
          <Field label="Categoria">
            <select value={f.category_id ?? ''} onChange={(e) => set('category_id', e.target.value ? Number(e.target.value) : null)}>
              <option value="">Sem categoria</option>
              {categories.filter((c) => c.kind === (isIncome ? 'income' : 'expense')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
        )}

        {isExpense && (
          <Field label="Pago com">
            <select value={f.where} onChange={(e) => set('where', e.target.value as 'account' | 'card')}>
              <option value="account">Conta (sai do saldo)</option>
              <option value="card">Cartão de crédito (entra na fatura)</option>
            </select>
          </Field>
        )}
        {isCardPurchase ? (
          <Field label="Cartão">
            <select value={f.card_id ?? ''} required onChange={(e) => set('card_id', e.target.value ? Number(e.target.value) : null)}>
              <option value="">Escolha…</option>
              {cards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` •••• ${c.last4}` : ''}</option>)}
            </select>
          </Field>
        ) : isExpense || isIncome || f.type === 'overdraft_payment' || f.type === 'reimbursement' ? (
          accountSelect(isIncome ? 'Conta que recebe' : 'Conta', 'account_id')
        ) : null}

        {f.type === 'transfer' && (<>{accountSelect('Conta de origem', 'account_id')}{accountSelect('Conta de destino', 'transfer_account_id')}</>)}
        {f.type === 'invoice_payment' && (<>
          {accountSelect('Conta que pagou', 'account_id')}
          <Field label="Cartão">
            <select value={f.card_id ?? ''} onChange={(e) => { set('card_id', e.target.value ? Number(e.target.value) : null); set('invoice_id', null); }}>
              <option value="">Escolha…</option>
              {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Fatura paga" hint="Vincule para o pagamento não ser contado de novo como fatura pendente.">
            <select value={f.invoice_id ?? ''} onChange={(e) => set('invoice_id', e.target.value ? Number(e.target.value) : null)} disabled={!f.card_id}>
              <option value="">Sem vínculo</option>
              {(invoices.data?.invoices ?? []).map((i) => <option key={i.id} value={i.id}>Vence {i.due_date.split('-').reverse().join('/')} — {brl(i.amount_cents)}</option>)}
            </select>
          </Field>
        </>)}

        {f.type === 'reimbursement' && (
          <Field label="Reembolso de qual despesa?" className="span2">
            <select value={f.reimbursement_for_id ?? ''} onChange={(e) => set('reimbursement_for_id', e.target.value ? Number(e.target.value) : null)}>
              <option value="">Não vincular</option>
              {(shared.data ?? []).filter((t) => t.others_cents > 0).map((t) => (
                <option key={t.id} value={t.id}>{t.description} ({monthShort(t.month_ref)}) — a receber {brl(t.others_cents - t.reimbursed_cents)}</option>
              ))}
            </select>
          </Field>
        )}

        {/* Datas */}
        {singleDate ? (
          <Field label={f.status === 'paid' ? 'Data' : 'Data prevista'}>
            <input type="date" value={(f.status === 'paid' ? f.occurred_on || f.paid_on : f.due_date) || ''}
              onChange={(e) => (f.status === 'paid' ? setF((s) => ({ ...s, occurred_on: e.target.value, paid_on: e.target.value })) : set('due_date', e.target.value))} />
          </Field>
        ) : (<>
          <Field label={isCardPurchase ? 'Data da compra' : isIncome ? 'Data do evento (opcional)' : 'Data da compra / do gasto'} hint={isCardPurchase ? 'Define a fatura e o mês do gasto.' : undefined}>
            <input type="date" value={f.occurred_on} onChange={(e) => set('occurred_on', e.target.value)} required={isCardPurchase} />
          </Field>
          {!isCardPurchase && (
            <Field label={isIncome ? 'Data prevista de recebimento' : 'Vencimento'}>
              <input type="date" value={f.due_date} onChange={(e) => set('due_date', e.target.value)} />
            </Field>
          )}
          {f.status === 'paid' && !isCardPurchase && (
            <Field label={isIncome ? 'Data em que recebi' : 'Data em que paguei'}>
              <input type="date" value={f.paid_on} onChange={(e) => set('paid_on', e.target.value)} />
            </Field>
          )}
        </>)}
        {!(f.occurred_on || f.due_date || f.paid_on) && (
          <Field label="Mês de referência" hint="Sem data definida, o item entra neste mês como “data a confirmar”.">
            <input type="month" value={f.month_ref} onChange={(e) => set('month_ref', e.target.value)} />
          </Field>
        )}
        {f.status === 'scheduled' && (
          <label className="check span2">
            <input type="checkbox" checked={f.date_confirmed} onChange={(e) => set('date_confirmed', e.target.checked)} />
            A data está confirmada
          </label>
        )}

        {/* Valores */}
        {isIncome ? (<>
          <MoneyField label="Salário bruto" value={f.gross} onChange={(v) => set('gross', v)} hint="Deixe vazio se só souber o líquido." />
          <MoneyField label="Impostos / descontos" value={f.deductions} onChange={(v) => set('deductions', v)} />
          {f.gross !== null ? (
            <div className="field"><span className="field-label">Líquido (calculado)</span><strong className="big">{brl(netIncome)}</strong></div>
          ) : (
            <MoneyField label="Valor líquido" value={f.total} onChange={(v) => set('total', v)} required />
          )}
        </>) : (
          <MoneyField
            label={isExpense ? 'Valor total pago pela conta/cartão' : 'Valor'} value={f.total} onChange={(v) => set('total', v)}
            required allowNegative={isExpense} hint={isExpense ? 'Estorno/crédito: use valor negativo.' : undefined}
          />
        )}
        {!tx && isCardPurchase && (<>
          <Field label="Parcelada? Total de parcelas" hint="Deixe vazio se for à vista. As parcelas restantes são previstas nas próximas faturas.">
            <input type="number" inputMode="numeric" min={2} max={120} value={f.inst_total} onChange={(e) => set('inst_total', e.target.value)} placeholder="Ex.: 10" />
          </Field>
          <Field label="Parcela atual" hint="Valor acima é o de CADA parcela. Em branco = 1ª parcela.">
            <input type="number" inputMode="numeric" min={1} max={120} value={f.inst_no} onChange={(e) => set('inst_no', e.target.value)} disabled={!f.inst_total} placeholder="1" />
          </Field>
        </>)}
        {tx?.installment_total && tx.installment_no && (
          <label className="check span2">
            <input type="checkbox" checked={f.apply_following} onChange={(e) => set('apply_following', e.target.checked)} />
            Compra parcelada ({tx.installment_no}/{tx.installment_total}): aplicar valor, categoria e divisão também às próximas parcelas previstas
          </label>
        )}
        {isExpense && (<>
          <MoneyField label="Minha parte" value={f.mine} onChange={(v) => set('mine', v)} allowNegative
            hint={f.mine !== null && f.total !== null ? `Outras pessoas: ${brl(f.total - f.mine)}` : 'Vazio = tudo é meu.'} />
          <Field label="Dividido com">
            <input value={f.shared_with} onChange={(e) => set('shared_with', e.target.value)} placeholder="Ex.: Ana, Pedro" maxLength={200} />
          </Field>
        </>)}
        {f.type === 'reimbursement' && (
          <Field label="Quem reembolsou">
            <input value={f.shared_with} onChange={(e) => set('shared_with', e.target.value)} maxLength={200} />
          </Field>
        )}

        <label className="check"><input type="checkbox" checked={f.is_estimate} onChange={(e) => set('is_estimate', e.target.checked)} /> Valor estimado (não confirmado)</label>
        <label className="check"><input type="checkbox" checked={f.needs_review} onChange={(e) => set('needs_review', e.target.checked)} /> Marcar para revisar</label>
        {f.needs_review && (
          <Field label="O que precisa revisar?" className="span2">
            <input value={f.review_note} onChange={(e) => set('review_note', e.target.value)} maxLength={500} />
          </Field>
        )}
        <Field label="Observações" className="span2">
          <textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={1000} />
        </Field>

        <div className="span2"><ErrorBox error={save.error} /></div>
        <div className="form-actions span2">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={save.isPending}>{save.isPending ? 'Salvando…' : 'Salvar'}</button>
        </div>
      </form>
    </Modal>
  );
}
