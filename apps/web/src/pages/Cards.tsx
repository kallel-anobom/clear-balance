import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Card, type Invoice, type InstallmentsResponse, type InvoiceDetail } from '../api';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, MoneyField, Panel } from '../components';
import { brl, dateBR, monthShort, todayISO } from '../format';
import { useLookups, useRefresh } from '../hooks';

const STATUS: Record<string, { label: string; tone: 'info' | 'warn' | 'good' | 'bad' }> = {
  open: { label: 'Aberta', tone: 'info' }, closed: { label: 'Fechada — a pagar', tone: 'warn' }, paid: { label: 'Paga', tone: 'good' },
};

function CardForm({ card, onClose }: { card?: Card; onClose: () => void }) {
  const { accounts } = useLookups();
  const refresh = useRefresh();
  const [f, setF] = useState({ name: card?.name ?? '', last4: card?.last4 ?? '', closing_day: String(card?.closing_day ?? ''), due_day: String(card?.due_day ?? ''), default_account_id: card?.default_account_id ?? null });
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, last4: f.last4 || null, closing_day: Number(f.closing_day), due_day: Number(f.due_day), default_account_id: f.default_account_id };
      return card ? api.put(`/cards/${card.id}`, body) : api.post('/cards', body);
    },
    onSuccess: () => { refresh(); onClose(); },
  });
  return (
    <Modal title={card ? 'Editar cartão' : 'Novo cartão'} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Nome do cartão" className="span2"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} autoFocus /></Field>
        <Field label="Dia de fechamento" hint="Compras até este dia entram na fatura que fecha no mês."><input type="number" min={1} max={31} value={f.closing_day} onChange={(e) => setF({ ...f, closing_day: e.target.value })} required /></Field>
        <Field label="Dia de vencimento"><input type="number" min={1} max={31} value={f.due_day} onChange={(e) => setF({ ...f, due_day: e.target.value })} required /></Field>
        <Field label="4 últimos dígitos (opcional)" hint="Nunca informe o número completo do cartão."><input value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, '').slice(0, 4) })} inputMode="numeric" pattern="\d{4}|" /></Field>
        <Field label="Conta que paga a fatura">
          <select value={f.default_account_id ?? ''} onChange={(e) => setF({ ...f, default_account_id: e.target.value ? Number(e.target.value) : null })}>
            <option value="">Não informada</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
        <div className="span2"><ErrorBox error={save.error} /></div>
        <div className="form-actions span2"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={save.isPending}>Salvar</button></div>
      </form>
    </Modal>
  );
}

function PayModal({ inv, defaultAccount, onClose }: { inv: Invoice; defaultAccount: number | null; onClose: () => void }) {
  const { accounts } = useLookups();
  const refresh = useRefresh();
  const [account, setAccount] = useState<number | null>(defaultAccount);
  const [date, setDate] = useState(todayISO());
  const [amount, setAmount] = useState<number | null>(inv.amount_cents);
  const pay = useMutation({
    mutationFn: () => api.post(`/invoices/${inv.id}/pay`, { account_id: account, paid_on: date, amount_cents: amount ?? undefined }),
    onSuccess: () => { refresh(); onClose(); },
  });
  return (
    <Modal title={`Pagar fatura ${inv.card_name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); pay.mutate(); }}>
        <p className="span2 muted">Isto registra <strong>uma saída de caixa</strong> pelo pagamento. As compras da fatura continuam sendo os gastos — o pagamento não é somado como despesa.</p>
        <Field label="Conta que pagou"><select value={account ?? ''} required onChange={(e) => setAccount(e.target.value ? Number(e.target.value) : null)}><option value="">Escolha…</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Data do pagamento"><input type="date" value={date} onChange={(e) => setDate(e.target.value)} required /></Field>
        <MoneyField label="Valor pago" value={amount} onChange={setAmount} required hint={inv.amount_estimated ? 'Valor calculado pelas compras lançadas — confira com a fatura.' : undefined} />
        <div className="span2"><ErrorBox error={pay.error} /></div>
        <div className="form-actions span2"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={pay.isPending}>Registrar pagamento</button></div>
      </form>
    </Modal>
  );
}

function InvoiceTotalModal({ inv, onClose }: { inv: Invoice; onClose: () => void }) {
  const refresh = useRefresh();
  const [v, setV] = useState<number | null>(inv.statement_total_cents ?? inv.lines_total_cents);
  const save = useMutation({ mutationFn: (value: number | null) => api.patch(`/invoices/${inv.id}`, { statement_total_cents: value }), onSuccess: () => { refresh(); onClose(); } });
  return (
    <Modal title="Total da fatura" onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(v); }}>
        <p className="span2 muted">Informe o total que consta na fatura do banco. Enquanto não confirmado, o valor é tratado como <Badge tone="warn">estimado</Badge> (soma das compras lançadas: {brl(inv.lines_total_cents)}).</p>
        <MoneyField label="Total da fatura" value={v} onChange={setV} required className="span2" />
        <div className="span2"><ErrorBox error={save.error} /></div>
        <div className="form-actions span2">
          {inv.statement_total_cents !== null && <button type="button" className="btn" onClick={() => save.mutate(null)}>Voltar a estimar</button>}
          <button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={save.isPending}>Confirmar total</button>
        </div>
      </form>
    </Modal>
  );
}

function NewInvoiceModal({ card, onClose }: { card: Card; onClose: () => void }) {
  const refresh = useRefresh();
  const [due, setDue] = useState('');
  const [total, setTotal] = useState<number | null>(null);
  const save = useMutation({ mutationFn: () => api.post('/invoices', { card_id: card.id, due_date: due, statement_total_cents: total }), onSuccess: () => { refresh(); onClose(); } });
  return (
    <Modal title={`Nova fatura — ${card.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="span2 muted">Use quando tiver só o total e o vencimento da fatura (sem as compras). As compras também criam faturas automaticamente.</p>
        <Field label="Vencimento"><input type="date" value={due} onChange={(e) => setDue(e.target.value)} required /></Field>
        <MoneyField label="Total da fatura (opcional)" value={total} onChange={setTotal} />
        <div className="span2"><ErrorBox error={save.error} /></div>
        <div className="form-actions span2"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={save.isPending}>Criar</button></div>
      </form>
    </Modal>
  );
}

function InvoiceCard({ inv, card, onPay, onTotal }: { inv: Invoice; card?: Card; onPay: () => void; onTotal: () => void }) {
  const [open, setOpen] = useState(false);
  const refresh = useRefresh();
  const detail = useQuery({ queryKey: ['invoice', inv.id], queryFn: () => api.get<InvoiceDetail>(`/invoices/${inv.id}`), enabled: open });
  const del = useMutation({ mutationFn: () => api.del(`/invoices/${inv.id}`), onSuccess: refresh });
  const st = inv.overdue ? { label: 'Vencida', tone: 'bad' as const } : STATUS[inv.status];
  void card;
  return (
    <li className="invoice">
      <div className="invoice-head">
        <div>
          <strong>Vence em {dateBR(inv.due_date)}</strong> <Badge tone={st.tone}>{st.label}</Badge>
          {inv.amount_estimated && <Badge tone="warn" title="Total da fatura ainda não confirmado">estimada</Badge>}
          <div className="dates">
            <span>Fechamento: {dateBR(inv.closing_date)}</span>
            <span>Vencimento: {dateBR(inv.due_date)}</span>
            <span>Pagamento: {inv.paid_on ? dateBR(inv.paid_on) : 'não pago'}</span>
          </div>
        </div>
        <div className="row-amount"><strong>{inv.amount_estimated ? '≈ ' : ''}{brl(inv.amount_cents)}</strong>
          <small className="muted">{inv.lines_count} compra(s) · minha parte {brl(inv.lines_mine_cents)}</small></div>
      </div>
      {inv.mismatch_cents !== null && inv.mismatch_cents !== 0 && (
        <div className="alert warn small">O total confirmado ({brl(inv.statement_total_cents)}) difere da soma das compras lançadas ({brl(inv.lines_total_cents)}) em {brl(Math.abs(inv.mismatch_cents))}. {inv.mismatch_cents > 0 ? 'Podem faltar compras ou haver encargos.' : 'Pode haver compra duplicada ou crédito não lançado.'}</div>
      )}
      <div className="tx-actions">
        <button className="btn small" onClick={() => setOpen(!open)}>{open ? 'Ocultar compras' : 'Ver compras'}</button>
        <button className="btn small" onClick={onTotal}>{inv.statement_total_cents === null ? 'Confirmar total' : 'Editar total'}</button>
        {inv.status !== 'paid' && <button className="btn small primary" onClick={onPay}>Pagar fatura</button>}
        {inv.lines_count === 0 && inv.status !== 'paid' && <button className="btn small danger" onClick={() => confirm('Apagar esta fatura?') && del.mutate()}>Apagar</button>}
      </div>
      <ErrorBox error={del.error} />
      {open && (detail.isLoading ? <Loading /> : (
        <div className="invoice-detail">
          <h4>Compras (gasto pela data da compra)</h4>
          {detail.data?.purchases.length === 0 ? <Empty>Sem compras lançadas.</Empty> : (
            <ul className="rows">{detail.data?.purchases.map((p) => (
              <li className="row" key={p.id}>
                <div className="row-main"><strong>{p.description}</strong><div className="row-sub">Compra em {dateBR(p.occurred_on)}{p.category_name ? ` · ${p.category_name}` : ''}</div></div>
                <div className="row-amount"><strong>{brl(p.total_cents)}</strong>{p.my_share_cents !== null && p.my_share_cents !== p.total_cents && <small>minha parte {brl(p.my_share_cents)}</small>}</div>
              </li>))}</ul>
          )}
          <h4>Pagamento (saída de caixa)</h4>
          {detail.data?.payments.length === 0 ? <Empty>Fatura ainda não paga.</Empty> : (
            <ul className="rows">{detail.data?.payments.map((p) => (
              <li className="row" key={p.id}><div className="row-main"><strong>{p.description}</strong><div className="row-sub">Pago em {dateBR(p.paid_on)}</div></div><div className="row-amount"><strong>{brl(p.total_cents)}</strong></div></li>))}</ul>
          )}
        </div>
      ))}
    </li>
  );
}

function InstallmentsPanel({ cardId }: { cardId: number | 'all' }) {
  const q = useQuery({
    queryKey: ['installments', cardId],
    queryFn: () => api.get<InstallmentsResponse>(`/installments${cardId === 'all' ? '' : `?card_id=${cardId}`}`),
  });
  const groups = q.data?.groups ?? [];
  if (!groups.length) return null;
  const total = q.data!.remaining_mine_cents;
  const months = q.data!.by_month.map((m) => [m.month, m.mine_cents] as const);
  const max = Math.max(...months.map(([, v]) => v), 1);
  return (
    <Panel title="Parcelas futuras" action={<span className="muted small">ainda a cair: {brl(total)} (minha parte)</span>}>
      <p className="muted small">Compras parceladas detectadas nas faturas (“PARC 02/10”) ou lançadas por você. As parcelas que faltam são <Badge tone="warn">projetadas</Badge> nas próximas faturas com o mesmo valor — são estimativas até aparecerem na fatura real.</p>
      <ul className="rows">{groups.map((g) => (
        <li className="row" key={g.group}>
          <div className="row-main">
            <strong>{g.description}</strong>
            <div className="row-sub">
              <Badge>{g.card_name}</Badge>
              <span>{g.last_real_no ? `na parcela ${g.last_real_no}/${g.total}` : `${g.total} parcelas`} · faltam {g.remaining_count}</span>
              {g.next_month && <span>de {monthShort(g.next_month)} até {monthShort(g.last_month!)}</span>}
            </div>
          </div>
          <div className="row-amount"><strong>{brl(g.remaining_mine_cents)}</strong><small className="muted">{brl(g.installment_mine_cents)} por parcela</small></div>
        </li>))}</ul>
      <h4>Quanto cai por mês</h4>
      <ul className="bars">{months.map(([m, v]) => (
        <li key={m}><div className="bar-head"><span>{monthShort(m)}</span><strong>{brl(v)}</strong></div><div className="bar"><div className="bar-plan" style={{ width: `${(v / max) * 100}%` }} /></div></li>
      ))}</ul>
    </Panel>
  );
}

export default function CardsPage({ month }: { month: string }) {
  void month;
  const { cards, accounts } = useLookups();
  const refresh = useRefresh();
  const [cardForm, setCardForm] = useState<{ card?: Card } | null>(null);
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [totalFor, setTotalFor] = useState<Invoice | null>(null);
  const [newFor, setNewFor] = useState<Card | null>(null);
  const [selected, setSelected] = useState<number | 'all'>('all');
  const q = useQuery({ queryKey: ['invoices', selected], queryFn: () => api.get<{ invoices: Invoice[]; unlinked_payments: { id: number; description: string; total_cents: number; paid_on: string | null; card_id: number | null }[] }>(`/invoices${selected === 'all' ? '' : `?card_id=${selected}`}`) });
  const link = useMutation({ mutationFn: ({ id, invoice_id }: { id: number; invoice_id: number }) => api.patch(`/transactions/${id}`, { invoice_id }), onSuccess: refresh });
  const delCard = useMutation({ mutationFn: (id: number) => api.del(`/cards/${id}`), onSuccess: () => { setSelected('all'); refresh(); } });

  const invoices = q.data?.invoices ?? [];
  const open = invoices.filter((i) => i.status !== 'paid');
  const paid = invoices.filter((i) => i.status === 'paid');

  return (
    <div className="stack">
      <div className="page-head">
        <h1>Cartões e faturas</h1>
        <button className="btn primary" onClick={() => setCardForm({})}>+ Novo cartão</button>
      </div>

      <div className="alert info">
        <strong>Como contamos:</strong> cada <em>compra</em> é um gasto, na <strong>data da compra</strong>. O <em>pagamento da fatura</em> é só saída de caixa, na <strong>data do pagamento</strong> — nunca é somado como despesa. Assim o mesmo gasto não é contado duas vezes.
      </div>

      {cards.length === 0 ? (
        <Empty>Nenhum cartão cadastrado. Clique em “Novo cartão” e informe os dias de fechamento e vencimento.</Empty>
      ) : (
        <div className="chips">
          <button className={`chip ${selected === 'all' ? 'active' : ''}`} onClick={() => setSelected('all')}>Todos</button>
          {cards.map((c) => <button key={c.id} className={`chip ${selected === c.id ? 'active' : ''}`} onClick={() => setSelected(c.id)}>{c.name}{c.last4 ? ` •••• ${c.last4}` : ''}</button>)}
        </div>
      )}

      {selected !== 'all' && (() => {
        const c = cards.find((x) => x.id === selected);
        return c ? (
          <Panel title={c.name} action={<div className="tx-actions"><button className="btn small" onClick={() => setNewFor(c)}>+ Fatura</button><button className="btn small" onClick={() => setCardForm({ card: c })}>Editar</button><button className="btn small danger" onClick={() => confirm(`Apagar o cartão "${c.name}" e suas faturas?`) && delCard.mutate(c.id)}>Apagar</button></div>}>
            <p className="muted small">Fecha dia {c.closing_day} · vence dia {c.due_day}{c.last4 ? ` · final ${c.last4}` : ''}{c.default_account_id ? ` · paga com ${accounts.find((a) => a.id === c.default_account_id)?.name ?? ''}` : ''}</p>
            <ErrorBox error={delCard.error} />
          </Panel>
        ) : null;
      })()}

      {(q.data?.unlinked_payments.length ?? 0) > 0 && (
        <Panel title="Pagamentos de fatura sem fatura vinculada">
          <p className="muted small">Vincule cada pagamento à fatura correta. Sem vínculo, a fatura continua “pendente” e pode ser contada duas vezes na previsão.</p>
          <ul className="rows">{q.data!.unlinked_payments.map((p) => (
            <li className="row" key={p.id}>
              <div className="row-main"><strong>{p.description}</strong><div className="row-sub">{dateBR(p.paid_on)} · {brl(p.total_cents)}</div></div>
              <select aria-label="Vincular à fatura" defaultValue="" onChange={(e) => e.target.value && link.mutate({ id: p.id, invoice_id: Number(e.target.value) })}>
                <option value="">Vincular à fatura…</option>
                {invoices.filter((i) => i.status !== 'paid' && (!p.card_id || i.card_id === p.card_id)).map((i) => <option key={i.id} value={i.id}>{i.card_name} — vence {dateBR(i.due_date)} — {brl(i.amount_cents)}</option>)}
              </select>
            </li>))}</ul>
          <ErrorBox error={link.error} />
        </Panel>
      )}

      <InstallmentsPanel cardId={selected} />

      {q.isLoading ? <Loading /> : invoices.length === 0 ? (cards.length > 0 && <Empty>Nenhuma fatura ainda. Elas são criadas ao lançar compras no cartão ou importar uma fatura.</Empty>) : (<>
        {open.length > 0 && <Panel title="A pagar"><ul className="invoices">{open.map((i) => <InvoiceCard key={i.id} inv={i} card={cards.find((c) => c.id === i.card_id)} onPay={() => setPaying(i)} onTotal={() => setTotalFor(i)} />)}</ul></Panel>}
        {paid.length > 0 && <Panel title="Pagas"><ul className="invoices">{paid.map((i) => <InvoiceCard key={i.id} inv={i} card={cards.find((c) => c.id === i.card_id)} onPay={() => setPaying(i)} onTotal={() => setTotalFor(i)} />)}</ul></Panel>}
      </>)}

      {cardForm && <CardForm card={cardForm.card} onClose={() => setCardForm(null)} />}
      {paying && <PayModal inv={paying} defaultAccount={cards.find((c) => c.id === paying.card_id)?.default_account_id ?? null} onClose={() => setPaying(null)} />}
      {totalFor && <InvoiceTotalModal inv={totalFor} onClose={() => setTotalFor(null)} />}
      {newFor && <NewInvoiceModal card={newFor} onClose={() => setNewFor(null)} />}
    </div>
  );
}
