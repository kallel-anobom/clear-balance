import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Card, type Invoice, type InstallmentsResponse, type InvoiceDetail, type InvoicesResponse, type LinkableInvoice, type UnlinkedPayment } from '../api';
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
          {inv.partial_total_cents != null && inv.statement_total_cents === null && <Badge tone="info" title="Valor parcial informado por você">parcial {brl(inv.partial_total_cents)} em {dateBR(inv.partial_on)}</Badge>}
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

/** Dias entre uma data AAAA-MM-DD e hoje (0 = hoje). */
function daysSince(iso: string): number {
  return Math.round((new Date(`${todayISO()}T00:00:00`).getTime() - new Date(`${iso}T00:00:00`).getTime()) / 86_400_000);
}

/** Valor parcial da fatura aberta: o total que o app do banco mostra hoje, para cartões que ainda não dão para importar. */
function PartialModal({ card, inv, onClose }: { card: Card; inv?: Invoice; onClose: () => void }) {
  const refresh = useRefresh();
  const [v, setV] = useState<number | null>(inv?.partial_total_cents ?? null);
  const save = useMutation({
    mutationFn: (value: number | null) => api.put('/invoices/partial', { card_id: card.id, invoice_id: inv?.id, partial_cents: value }),
    onSuccess: () => { refresh(); onClose(); },
  });
  return (
    <Modal title={`Valor parcial — ${card.name}`} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); if (v !== null) save.mutate(v); }}>
        <p className="span2 muted">
          Informe o <strong>total da fatura aberta</strong> que o app do banco mostra hoje (com parcelas e tudo). Não precisa lançar compra por compra.
          A previsão usa o maior entre este valor e as compras lançadas. Não é o total confirmado: quando a fatura fechar, importe-a e confirme o total
          (aí este valor sai de cena sozinho). Atualize sempre que o valor mudar; ele fica marcado como desatualizado depois de 3 dias.
        </p>
        <MoneyField label="Total da fatura hoje" value={v} onChange={setV} required className="span2"
          hint={inv ? `Fatura que vence em ${dateBR(inv.due_date)}. Compras já lançadas nela: ${brl(inv.lines_total_cents)}.` : 'Vai para a fatura aberta do cartão (criada se ainda não existir).'} />
        <div className="span2"><ErrorBox error={save.error} /></div>
        <div className="form-actions span2">
          {inv?.partial_total_cents != null && <button type="button" className="btn" disabled={save.isPending} onClick={() => save.mutate(null)}>Remover valor parcial</button>}
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={save.isPending || v === null}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

/** Uma linha por cartão com a fatura aberta e o frescor do valor, para manter a previsão do mês em dia. */
function OpenInvoicesPanel({ cards, invoices, onPartial }: { cards: Card[]; invoices: Invoice[]; onPartial: (card: Card, inv?: Invoice) => void }) {
  if (!cards.length) return null;
  return (
    <Panel title="Faturas abertas — manter atualizadas">
      <p className="muted small">
        A previsão do mês depende do valor das faturas abertas. Cartão que dá para importar (CSV/XLSX): reimporte a fatura aberta. Cartão que só libera a fatura depois do fechamento
        (ex.: Santander, Mercado Livre): informe o <strong>valor parcial</strong> que o app do banco mostra hoje. Se você importou as compras, o sistema usa o maior valor entre elas e o parcial.
      </p>
      <ul className="rows">
        {cards.map((c) => {
          const open = invoices.filter((i) => i.card_id === c.id && i.status === 'open' && i.statement_total_cents === null).sort((a, b) => a.due_date.localeCompare(b.due_date))[0];
          const age = open?.partial_on ? daysSince(open.partial_on) : null;
          return (
            <li className="row" key={c.id} style={{ flexWrap: 'wrap' }}>
              <div className="row-main" style={{ minWidth: 220 }}>
                <strong>{c.name}</strong>
                <div className="row-sub">
                  {open ? <span>vence {dateBR(open.due_date)} · {open.lines_count} compra(s) lançada(s)</span> : <span>sem fatura aberta ainda</span>}
                  {open?.partial_total_cents != null && (
                    <Badge tone={age !== null && age > 3 ? 'warn' : 'info'}>
                      parcial de {brl(open.partial_total_cents)} {age === 0 ? 'informado hoje' : `há ${age} dia(s)`}{age !== null && age > 3 ? ' — atualize' : ''}
                    </Badge>
                  )}
                </div>
              </div>
              <div className="row-amount" style={{ flex: '0 1 auto' }}>
                {open && <strong>≈ {brl(open.amount_cents)}</strong>}
                <button className="btn small" onClick={() => onPartial(c, open)}>{open?.partial_total_cents != null ? 'Atualizar valor parcial' : 'Informar valor parcial'}</button>
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** Baixa a conferência do mês em JSON (para guardar ou colar numa conversa de análise). */
function DownloadReport({ month }: { month: string }) {
  const [withLines, setWithLines] = useState(false);
  const dl = useMutation({
    mutationFn: async () => {
      const data = await api.get<unknown>(`/overview/report?month=${month}${withLines ? '&lines=1' : ''}`);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `conferencia-${month}${withLines ? '-com-lancamentos' : ''}.json`;
      a.click();
      URL.revokeObjectURL(url);
    },
  });
  return (
    <div className="tx-actions" style={{ alignItems: 'center' }}>
      <label className="small muted" style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="checkbox" checked={withLines} onChange={(e) => setWithLines(e.target.checked)} />
        incluir lançamentos (descrições e valores)
      </label>
      <button className="btn" disabled={dl.isPending} onClick={() => dl.mutate()} title="Números do mês, previsão e faturas. Sem chaves nem senhas; descrições só se marcar a opção.">
        {dl.isPending ? 'Gerando…' : 'Baixar conferência'}
      </button>
      <ErrorBox error={dl.error} />
    </div>
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

/**
 * Pagamentos que saíram da conta corrente (vieram do extrato) e ainda não foram ligados à fatura do cartão.
 * Sem o vínculo a fatura continua "pendente" e o mesmo dinheiro é contado duas vezes na previsão.
 */
function UnlinkedPaymentsPanel({ payments, options, busy, error, onLink, onLinkAll }: {
  payments: UnlinkedPayment[]; options: LinkableInvoice[]; busy: boolean; error: unknown;
  onLink: (id: number, invoiceId: number) => void; onLinkAll: (pairs: { id: number; invoice_id: number }[]) => void;
}) {
  const [showAll, setShowAll] = useState<Set<number>>(new Set());
  const byId = new Map(options.map((o) => [o.id, o]));
  const label = (o: LinkableInvoice) => `${o.card_name} — vence ${dateBR(o.due_date)} — ${brl(o.amount_cents)}`;
  const sure = payments.flatMap((p) => (p.suggestion?.confidence === 'alta' ? [{ id: p.id, invoice_id: p.suggestion.invoice_id }] : []));

  return (
    <Panel
      title="Pagamentos de fatura que saíram da conta"
      action={sure.length > 1 ? <button className="btn small primary" disabled={busy} onClick={() => onLinkAll(sure)}>Vincular as {sure.length} sugestões certeiras</button> : undefined}
    >
      <p className="muted small">
        Estes pagamentos vieram do extrato da <strong>conta corrente</strong> e ainda não estão ligados à fatura do <strong>cartão</strong>. Ligue cada um à fatura que ele pagou:
        a fatura passa para “Paga” e deixa de contar de novo em “ainda falta pagar”. Não use “Pagar fatura”, que criaria outro pagamento.
      </p>
      <ul className="rows">
        {payments.map((p) => {
          const s = p.suggestion ? byId.get(p.suggestion.invoice_id) : undefined;
          const ids = showAll.has(p.id) ? options.map((o) => o.id) : p.candidate_invoice_ids;
          return (
            <li className="row" key={p.id} style={{ flexWrap: 'wrap' }}>
              <div className="row-main" style={{ minWidth: 240 }}>
                <strong>{p.description}</strong>
                <div className="row-sub">
                  {p.paid_on ? dateBR(p.paid_on) : 'sem data'} · {brl(p.total_cents)}{p.account_name ? ` · saiu da conta ${p.account_name}` : ''}
                </div>
                {p.suspicious && (
                  <div className="row-sub">
                    <Badge tone="warn">Não parece pagamento de fatura</Badge> Se for outra coisa, mude o tipo em <Link to="/lancamentos">Lançamentos</Link>.
                  </div>
                )}
                {s && p.suggestion && (
                  <div className="row-sub">
                    <Badge tone={p.suggestion.confidence === 'alta' ? 'good' : 'info'}>Sugestão {p.suggestion.confidence === 'alta' ? 'certeira' : '(confira)'}</Badge>
                    {label(s)} <span title={p.suggestion.reason}>ⓘ</span>
                  </div>
                )}
              </div>
              <div className="row-amount" style={{ flex: '1 1 260px', maxWidth: 380, alignItems: 'stretch' }}>
                {s && <button className="btn small primary" disabled={busy} onClick={() => onLink(p.id, s.id)}>Vincular</button>}
                <select aria-label="Escolher outra fatura" defaultValue="" disabled={busy} style={{ width: '100%' }} onChange={(e) => e.target.value && onLink(p.id, Number(e.target.value))}>
                  <option value="">{s ? 'Outra fatura…' : 'Vincular à fatura…'}</option>
                  {ids.flatMap((id) => { const o = byId.get(id); return o ? [<option key={o.id} value={o.id}>{label(o)}</option>] : []; })}
                </select>
                {!showAll.has(p.id) && (
                  <button className="btn small" type="button" onClick={() => setShowAll(new Set(showAll).add(p.id))}>Mostrar todas as faturas</button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <ErrorBox error={error} />
    </Panel>
  );
}

export default function CardsPage({ month }: { month: string }) {
  const { cards, accounts } = useLookups();
  const refresh = useRefresh();
  const [cardForm, setCardForm] = useState<{ card?: Card } | null>(null);
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [totalFor, setTotalFor] = useState<Invoice | null>(null);
  const [newFor, setNewFor] = useState<Card | null>(null);
  const [partialFor, setPartialFor] = useState<{ card: Card; inv?: Invoice } | null>(null);
  const [selected, setSelected] = useState<number | 'all'>('all');
  const q = useQuery({ queryKey: ['invoices', selected], queryFn: () => api.get<InvoicesResponse>(`/invoices${selected === 'all' ? '' : `?card_id=${selected}`}`) });
  const link = useMutation({ mutationFn: ({ id, invoice_id }: { id: number; invoice_id: number }) => api.patch(`/transactions/${id}`, { invoice_id }), onSuccess: refresh });
  // Vincula várias de uma vez (as sugestões de confiança alta), uma por uma para respeitar as regras de cada lançamento.
  const linkAll = useMutation({
    mutationFn: async (pairs: { id: number; invoice_id: number }[]) => { for (const p of pairs) await api.patch(`/transactions/${p.id}`, { invoice_id: p.invoice_id }); },
    onSuccess: refresh,
  });
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
      <DownloadReport month={month} />

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
        <UnlinkedPaymentsPanel
          payments={q.data!.unlinked_payments}
          options={q.data!.linkable_invoices}
          busy={link.isPending || linkAll.isPending}
          error={link.error ?? linkAll.error}
          onLink={(id, invoice_id) => link.mutate({ id, invoice_id })}
          onLinkAll={(pairs) => linkAll.mutate(pairs)}
        />
      )}

      <OpenInvoicesPanel cards={selected === 'all' ? cards : cards.filter((c) => c.id === selected)} invoices={invoices} onPartial={(card, inv) => setPartialFor({ card, inv })} />

      <InstallmentsPanel cardId={selected} />

      {q.isLoading ? <Loading /> : invoices.length === 0 ? (cards.length > 0 && <Empty>Nenhuma fatura ainda. Elas são criadas ao lançar compras no cartão ou importar uma fatura.</Empty>) : (<>
        {open.length > 0 && <Panel title="A pagar"><ul className="invoices">{open.map((i) => <InvoiceCard key={i.id} inv={i} card={cards.find((c) => c.id === i.card_id)} onPay={() => setPaying(i)} onTotal={() => setTotalFor(i)} />)}</ul></Panel>}
        {paid.length > 0 && <Panel title="Pagas"><ul className="invoices">{paid.map((i) => <InvoiceCard key={i.id} inv={i} card={cards.find((c) => c.id === i.card_id)} onPay={() => setPaying(i)} onTotal={() => setTotalFor(i)} />)}</ul></Panel>}
      </>)}

      {cardForm && <CardForm card={cardForm.card} onClose={() => setCardForm(null)} />}
      {paying && <PayModal inv={paying} defaultAccount={cards.find((c) => c.id === paying.card_id)?.default_account_id ?? null} onClose={() => setPaying(null)} />}
      {totalFor && <InvoiceTotalModal inv={totalFor} onClose={() => setTotalFor(null)} />}
      {newFor && <NewInvoiceModal card={newFor} onClose={() => setNewFor(null)} />}
      {partialFor && <PartialModal card={partialFor.card} inv={partialFor.inv} onClose={() => setPartialFor(null)} />}
    </div>
  );
}
