import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs, type Tx } from '../api';
import { Badge, Empty, ErrorBox, Loading, Panel } from '../components';
import { TYPE_LABEL, brl, dateBR } from '../format';
import { useLookups, useRefresh } from '../hooks';
import { MarkPaid } from '../MarkPaid';
import { TxForm, type TxPreset } from '../TxForm';

const SIGN: Record<string, string> = { income: '+', reimbursement: '+', expense: '−', invoice_payment: '−', overdraft_payment: '−', transfer: '↔' };

export default function TransactionsPage({ month }: { month: string }) {
  const [params] = useSearchParams();
  const { accounts, cards, categories } = useLookups();
  const refresh = useRefresh();
  const [f, setF] = useState({
    category_id: '', account_id: '', card_id: '', type: '', status: '', q: '', needs_review: params.get('revisar') === '1',
  });
  const [editing, setEditing] = useState<{ tx?: Tx; preset?: TxPreset; title?: string } | null>(null);
  const [paying, setPaying] = useState<Tx | null>(null);

  const list = useQuery({
    queryKey: ['transactions', month, f],
    queryFn: () => api.get<Tx[]>(`/transactions${qs({ month, ...f, needs_review: f.needs_review })}`),
  });
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: number; body: Record<string, unknown> }) => api.patch(`/transactions/${id}`, body),
    onSuccess: refresh,
  });
  const del = useMutation({
    mutationFn: ({ id, following }: { id: number; following: boolean }) => api.del(`/transactions/${id}${following ? '?scope=following' : ''}`),
    onSuccess: refresh,
  });
  const askDelete = (t: Tx) => {
    if (!confirm(`Apagar "${t.description}"?`)) return;
    // Compra parcelada: oferece apagar também as parcelas futuras ainda previstas.
    const more = !!t.installment_group && !!t.installment_no && !!t.installment_total && t.installment_no < t.installment_total;
    del.mutate({ id: t.id, following: more && confirm('Apagar também as próximas parcelas previstas desta compra?\n\nOK = apagar esta e as próximas\nCancelar = apagar só esta') });
  };

  const rows = list.data ?? [];
  const totalMine = rows.filter((t) => t.type === 'expense').reduce((s, t) => s + (t.my_share_cents ?? t.total_cents), 0);
  const totalIncome = rows.filter((t) => t.type === 'income').reduce((s, t) => s + t.total_cents, 0);
  const set = (k: keyof typeof f, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Lançamentos</h1>
        <button className="btn primary" onClick={() => setEditing({})}>+ Novo lançamento</button>
      </div>

      <Panel>
        <div className="filters">
          <input type="search" placeholder="Buscar descrição…" value={f.q} onChange={(e) => set('q', e.target.value)} aria-label="Buscar" />
          <select value={f.type} onChange={(e) => set('type', e.target.value)} aria-label="Tipo">
            <option value="">Todos os tipos</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <select value={f.category_id} onChange={(e) => set('category_id', e.target.value)} aria-label="Categoria">
            <option value="">Todas as categorias</option>
            <option value="none">Sem categoria</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={f.account_id} onChange={(e) => set('account_id', e.target.value)} aria-label="Conta">
            <option value="">Todas as contas</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={f.card_id} onChange={(e) => set('card_id', e.target.value)} aria-label="Cartão">
            <option value="">Todos os cartões</option>
            {cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <select value={f.status} onChange={(e) => set('status', e.target.value)} aria-label="Situação">
            <option value="">Pagos e previstos</option>
            <option value="paid">Só realizados</option>
            <option value="scheduled">Só previstos</option>
          </select>
          <label className="check"><input type="checkbox" checked={f.needs_review} onChange={(e) => set('needs_review', e.target.checked)} /> Só para revisar</label>
        </div>
        <p className="muted small">
          {rows.length} lançamento(s) · despesas (minha parte) {brl(totalMine)} · receitas (líquido) {brl(totalIncome)}. Transferências, pagamentos de fatura e reembolsos não entram nesses totais.
        </p>
      </Panel>

      <ErrorBox error={list.error ?? patch.error ?? del.error} />
      {list.isLoading ? <Loading /> : rows.length === 0 ? <Empty>Nenhum lançamento com estes filtros.</Empty> : (
        <ul className="tx-list">
          {rows.map((t) => {
            const date = t.occurred_on ?? t.due_date ?? t.paid_on;
            const shared = t.type === 'expense' && t.my_share_cents !== null && t.my_share_cents !== t.total_cents;
            const pendingReimb = t.others_cents - t.reimbursed_cents;
            return (
              <li key={t.id} className={`tx ${t.needs_review ? 'review' : ''}`}>
                <div className="tx-date">{date ? dateBR(date).slice(0, 5) : '—'}<small>{date?.slice(0, 4)}</small></div>
                <div className="tx-main">
                  <div className="tx-title">
                    <strong>{t.description}</strong>
                    {t.installment_no && t.installment_total && <Badge tone="info" title="Compra parcelada">parcela {t.installment_no}/{t.installment_total}</Badge>}
                    {t.is_projected && <Badge tone="warn" title="Criada pelo sistema a partir de uma parcela anterior; será confirmada quando aparecer na fatura">projetada</Badge>}
                    {t.status === 'scheduled' && <Badge tone="info">previsto</Badge>}
                    {t.is_estimate && <Badge tone="warn">estimado</Badge>}
                    {t.status === 'scheduled' && !t.date_confirmed && <Badge tone="warn">data a confirmar</Badge>}
                    {t.needs_review && <Badge tone="bad" title={t.review_note ?? ''}>revisar</Badge>}
                    {t.type !== 'expense' && t.type !== 'income' && <Badge>{TYPE_LABEL[t.type]}</Badge>}
                    {t.import_batch_id && <Badge title="Veio de importação">importado</Badge>}
                  </div>
                  <div className="tx-sub">
                    {t.type === 'transfer'
                      ? `${t.account_name ?? 'conta não informada'} → ${t.transfer_account_name ?? 'conta não informada'}`
                      : [t.card_name ? `Cartão ${t.card_name}` : t.account_name, t.category_name].filter(Boolean).join(' · ') || 'sem conta/categoria'}
                    {t.due_date && t.due_date !== date && ` · vence ${dateBR(t.due_date)}`}
                    {t.paid_on && t.paid_on !== date && ` · pago em ${dateBR(t.paid_on)}`}
                    {t.type === 'expense' && t.card_id && ' · sai da conta só no pagamento da fatura'}
                  </div>
                  {t.needs_review && t.review_note && <div className="tx-note">⚠ {t.review_note}</div>}
                  {shared && (
                    <div className="tx-sub">
                      Minha parte {brl(t.my_share_cents)} · outras pessoas {brl(t.others_cents)}{t.shared_with ? ` (${t.shared_with})` : ''}
                      {t.others_cents > 0 && (pendingReimb > 0 ? <> · <Badge tone="warn">a receber {brl(pendingReimb)}</Badge></> : <> · <Badge tone="good">reembolsado</Badge></>)}
                    </div>
                  )}
                  <div className="tx-actions">
                    {(t.type === 'expense' || t.type === 'income') && (
                      <select value={t.category_id ?? ''} aria-label="Categoria" onChange={(e) => patch.mutate({ id: t.id, body: { category_id: e.target.value ? Number(e.target.value) : null } })}>
                        <option value="">Sem categoria</option>
                        {categories.filter((c) => c.kind === (t.type === 'income' ? 'income' : 'expense')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                      </select>
                    )}
                    {t.status === 'scheduled' && t.type !== 'transfer' && <button className="btn small" onClick={() => setPaying(t)}>{t.type === 'income' ? 'Marcar recebido' : 'Marcar pago'}</button>}
                    {shared && pendingReimb > 0 && (
                      <button className="btn small" onClick={() => setEditing({ title: 'Registrar reembolso recebido', preset: {
                        type: 'reimbursement', description: `Reembolso: ${t.description}`, reimbursement_for_id: t.id, total: pendingReimb,
                        shared_with: t.shared_with ?? '', account_id: t.account_id, status: 'paid',
                      } })}>Registrar reembolso</button>
                    )}
                    <button className="btn small" onClick={() => patch.mutate({ id: t.id, body: { needs_review: !t.needs_review } })}>{t.needs_review ? 'Tirar da revisão' : 'Marcar p/ revisar'}</button>
                    <button className="btn small" onClick={() => setEditing({ tx: t })}>Editar</button>
                    <button className="btn small danger" onClick={() => askDelete(t)}>Apagar</button>
                  </div>
                </div>
                <div className={`tx-amount ${t.type}`}>
                  <strong>{SIGN[t.type]} {brl(Math.abs(t.total_cents))}</strong>
                  {t.type === 'income' && t.gross_cents !== null && <small>bruto {brl(t.gross_cents)}</small>}
                  {shared && <small>minha parte {brl(t.my_share_cents)}</small>}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing && <TxForm tx={editing.tx} preset={editing.preset} title={editing.title} month={month} onClose={() => setEditing(null)} />}
      {paying && <MarkPaid txId={paying.id} label={paying.description} amount={paying.total_cents} income={paying.type === 'income'} onClose={() => setPaying(null)} />}
    </div>
  );
}
