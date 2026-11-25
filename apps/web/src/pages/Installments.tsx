import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type InstallmentGroup, type InstallmentsResponse } from '../api';
import { Badge, Empty, ErrorBox, Loading, Panel } from '../components';
import { brl, monthShort } from '../format';

type Sort = 'next' | 'remaining' | 'end' | 'installment';

const SORTS: { value: Sort; label: string }[] = [
  { value: 'next', label: 'Próxima a cair' },
  { value: 'remaining', label: 'Maior valor restante' },
  { value: 'installment', label: 'Maior parcela' },
  { value: 'end', label: 'Acaba primeiro' },
];

const bySort = (sort: Sort) => (a: InstallmentGroup, b: InstallmentGroup) => {
  const text = a.description.localeCompare(b.description, 'pt-BR');
  if (sort === 'remaining') return b.remaining_mine_cents - a.remaining_mine_cents || text;
  if (sort === 'installment') return b.installment_mine_cents - a.installment_mine_cents || text;
  const key = sort === 'end' ? 'end_month' : 'next_month';
  return (a[key] ?? '9999-99').localeCompare(b[key] ?? '9999-99') || text;
};

function GroupRow({ g }: { g: InstallmentGroup }) {
  const done = g.remaining_count === 0;
  const current = g.last_real_no ?? 0;
  return (
    <li className="row" style={done ? { opacity: 0.6 } : undefined}>
      <div className="row-main">
        <strong>{g.description}</strong>
        <div className="row-sub">
          <Badge tone={done ? 'good' : 'info'}>{done ? `quitada · ${g.total}x` : g.last_real_no ? `parcela ${current}/${g.total}` : `${g.total} parcelas`}</Badge>
          {!done && <span>faltam {g.remaining_count}</span>}
          {g.next_month && g.last_month && (
            <span>{g.next_month === g.last_month ? `cai em ${monthShort(g.next_month)}` : `de ${monthShort(g.next_month)} até ${monthShort(g.last_month)}`}</span>
          )}
          {done && g.end_month && <span>última em {monthShort(g.end_month)}</span>}
        </div>
        <progress
          max={g.total}
          value={Math.min(current, g.total)}
          aria-label={`${current} de ${g.total} parcelas já lançadas`}
          style={{ width: '100%', height: 8, marginTop: 6 }}
        />
      </div>
      <div className="row-amount">
        <strong>{done ? brl(g.paid_mine_cents) : brl(g.remaining_mine_cents)}</strong>
        <small className="muted">{done ? 'total pago' : 'ainda a cair'}</small>
        <small className="muted">{brl(g.installment_mine_cents)} por parcela</small>
      </div>
    </li>
  );
}

/** Todas as compras parceladas de todos os cartões numa tela só, com o que ainda vai cair em cada mês. */
export default function InstallmentsPage() {
  const [card, setCard] = useState<number | 'all'>('all');
  const [sort, setSort] = useState<Sort>('next');
  const [showDone, setShowDone] = useState(false);
  const q = useQuery({
    queryKey: ['installments-page'],
    queryFn: () => api.get<InstallmentsResponse>('/installments?include_done=1'),
  });

  if (q.isLoading) return <Loading />;
  if (q.error) return <ErrorBox error={q.error} />;
  const data = q.data!;

  const cards = [...new Map(data.groups.map((g) => [g.card_id, g.card_name] as const)).entries()].map(([id, name]) => ({ id, name }));
  const inCard = (g: InstallmentGroup) => card === 'all' || g.card_id === card;
  const active = data.groups.filter((g) => g.remaining_count > 0 && inCard(g));
  const done = data.groups.filter((g) => g.remaining_count === 0 && inCard(g));
  const remaining = active.reduce((s, g) => s + g.remaining_mine_cents, 0);
  const perInstallment = active.reduce((s, g) => s + g.installment_mine_cents, 0);
  const lastMonth = active.reduce<string | null>((m, g) => (g.last_month && (!m || g.last_month > m) ? g.last_month : m), null);

  const months = data.by_month
    .map((m) => ({ ...m, cards: m.cards.filter((c) => card === 'all' || c.card_id === card) }))
    .map((m) => ({ ...m, mine_cents: m.cards.reduce((s, c) => s + c.mine_cents, 0) }))
    .filter((m) => m.mine_cents > 0);
  const maxMonth = Math.max(...months.map((m) => m.mine_cents), 1);

  // Uma seção por cartão (na visão "Todos"), cada uma com o subtotal do que ainda falta cair.
  const sections = cards
    .filter((c) => card === 'all' || c.id === card)
    .map((c) => {
      const list = [...active.filter((g) => g.card_id === c.id), ...(showDone ? done.filter((g) => g.card_id === c.id) : [])];
      const act = list.filter((g) => g.remaining_count > 0).sort(bySort(sort));
      const fin = list.filter((g) => g.remaining_count === 0).sort(bySort('end'));
      return { ...c, items: [...act, ...fin], remaining: act.reduce((s, g) => s + g.remaining_mine_cents, 0), activeCount: act.length };
    })
    .filter((s) => s.items.length > 0)
    .sort((a, b) => b.remaining - a.remaining);

  return (
    <>
      <h1>Parcelas</h1>
      <p className="muted small">
        Todas as compras parceladas dos seus cartões. As parcelas que faltam são <Badge tone="warn">projetadas</Badge> com o mesmo valor da parcela atual — são estimativas até
        aparecerem na fatura real. Os valores são a sua parte. Para corrigir uma parcela, edite o lançamento em <Link to="/lancamentos">Lançamentos</Link>.
      </p>

      {cards.length > 1 && (
        <div className="chips" role="group" aria-label="Filtrar por cartão">
          <button className={`chip ${card === 'all' ? 'active' : ''}`} onClick={() => setCard('all')}>Todos</button>
          {cards.map((c) => <button key={c.id} className={`chip ${card === c.id ? 'active' : ''}`} onClick={() => setCard(c.id)}>{c.name}</button>)}
        </div>
      )}

      {active.length === 0 && done.length === 0 ? (
        <Empty>Nenhuma compra parcelada ainda. Elas aparecem ao importar uma fatura com “PARC 02/10” na descrição ou ao lançar uma compra parcelada.</Empty>
      ) : (
        <>
          <div className="kpis">
            <div className="kpi"><span className="kpi-label">Ainda a cair</span><span className="kpi-value">{brl(remaining)}</span><span className="kpi-sub">minha parte, nas parcelas que faltam</span></div>
            <div className="kpi"><span className="kpi-label">Compras parceladas em andamento</span><span className="kpi-value">{active.length}</span><span className="kpi-sub">{lastMonth ? `a última parcela cai em ${monthShort(lastMonth)}` : 'nenhuma parcela pendente'}</span></div>
            <div className="kpi"><span className="kpi-label">Soma das parcelas de um mês</span><span className="kpi-value">{brl(perInstallment)}</span><span className="kpi-sub">quanto pesa por mês enquanto todas estiverem rodando</span></div>
          </div>

          <Panel
            title="Compras parceladas"
            action={
              <div className="tx-actions">
                <label className="small">
                  Ordenar:{' '}
                  <select value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar compras parceladas">
                    {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                  </select>
                </label>
                {done.length > 0 && (
                  <label className="small">
                    <input type="checkbox" checked={showDone} onChange={(e) => setShowDone(e.target.checked)} /> mostrar quitadas ({done.length})
                  </label>
                )}
              </div>
            }
          >
            {sections.length === 0 ? (
              <Empty>Nenhuma compra parcelada em andamento{card === 'all' ? '' : ' neste cartão'}. Marque “mostrar quitadas” para ver as que já terminaram.</Empty>
            ) : (
              sections.map((s) => (
                <div key={s.id}>
                  <h4 style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                    <span>{s.name}</span>
                    <span className="muted small">{s.activeCount} em andamento · ainda a cair {brl(s.remaining)}</span>
                  </h4>
                  <ul className="rows">{s.items.map((g) => <GroupRow key={g.group} g={g} />)}</ul>
                </div>
              ))
            )}
          </Panel>

          {months.length > 0 && (
            <Panel title="Quanto cai por mês" action={<span className="muted small">só parcelas ainda previstas</span>}>
              <ul className="bars">
                {months.map((m) => (
                  <li key={m.month}>
                    <div className="bar-head"><span>{monthShort(m.month)} · {m.count} parcela{m.count === 1 ? '' : 's'}</span><strong>{brl(m.mine_cents)}</strong></div>
                    <div className="bar"><div className="bar-plan" style={{ width: `${(m.mine_cents / maxMonth) * 100}%` }} /></div>
                    {card === 'all' && m.cards.length > 1 && (
                      <small className="muted">{m.cards.map((c) => `${c.card_name} ${brl(c.mine_cents)}`).join(' · ')}</small>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </>
      )}
    </>
  );
}
