import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs, type FlowItem, type Overview } from '../api';
import { Badge, Empty, ErrorBox, Loading, Panel } from '../components';
import { brl, dateBR, monthLabel, monthShort } from '../format';
import { MarkPaid } from '../MarkPaid';

function FlowRow({ item, onPay, month }: { item: FlowItem; onPay: (i: FlowItem) => void; month: string }) {
  return (
    <li className="row">
      <div className="row-main">
        <strong>{item.label}</strong>
        <div className="row-sub">
          {item.date ? dateBR(item.date) : <Badge tone="warn">sem data</Badge>}
          {item.kind === 'fatura' && <Badge tone="info">fatura</Badge>}
          {item.kind === 'cheque_especial' && <Badge tone="info">cheque especial</Badge>}
          {item.estimated && <Badge tone="warn" title="Valor ainda não confirmado">estimado</Badge>}
          {item.status === 'pending' && !item.date_confirmed && item.date && <Badge tone="warn">data a confirmar</Badge>}
          {item.overdue && <Badge tone="bad">vencido</Badge>}
        </div>
      </div>
      <div className="row-amount">
        <strong className={item.estimated ? 'estimated' : ''}>{item.estimated ? '≈ ' : ''}{brl(item.amount_cents)}</strong>
        {item.status === 'pending' && item.tx_id && <button className="btn small" onClick={() => onPay(item)}>Marcar pago</button>}
        {item.status === 'pending' && item.invoice_id && !item.tx_id && <Link className="btn small" to={`/cartoes?mes=${month}`}>Pagar</Link>}
        {item.status === 'paid' && <Badge tone="good">pago</Badge>}
      </div>
    </li>
  );
}

function CostBreakdown({ spending }: { spending: Overview['spending'] }) {
  const { breakdown, excluded } = spending;
  if (breakdown.length === 0 && excluded.length === 0) return null;
  const sum = breakdown.reduce((a, b) => a + b.total_cents, 0);
  return (
    <Panel title="Como chegamos no custo do mês">
      <details className="cost-details" open={spending.total_mine_cents > 0}>
        <summary className="muted small">
          Custo = tudo o que você gastou no mês (compras do cartão contam na data da compra). Clique para ver a conta.
        </summary>
        {breakdown.length === 0 ? <Empty>Sem despesas neste mês.</Empty> : (
          <ul className="rows">
            {breakdown.map((b) => (
              <li className="row" key={b.key}>
                <div className="row-main">
                  <strong>{b.label}</strong>
                  <div className="row-sub">
                    {b.count} {b.count === 1 ? 'lançamento' : 'lançamentos'} · já gasto {brl(b.paid_cents)} · previsto {brl(b.planned_cents)}
                    {b.projected_count > 0 && <Badge tone="warn" title="Parcelas futuras previstas a partir de compras parceladas">{b.projected_count} prevista{b.projected_count > 1 ? 's' : ''}</Badge>}
                  </div>
                  <div className="muted small">{b.hint}</div>
                </div>
                <div className="row-amount"><strong>{brl(b.total_cents)}</strong></div>
              </li>
            ))}
            <li className="row total-row">
              <div className="row-main"><strong>Custo total do mês</strong></div>
              <div className="row-amount"><strong>{brl(sum)}</strong></div>
            </li>
          </ul>
        )}
        {excluded.length > 0 && (
          <>
            <h4 className="subhead">Não entra no custo (para não contar duas vezes)</h4>
            <ul className="rows">
              {excluded.map((e) => (
                <li className="row" key={e.code}>
                  <div className="row-main">
                    <strong>{e.label}</strong>
                    <div className="row-sub">{e.count} {e.count === 1 ? 'item' : 'itens'}</div>
                    <div className="muted small">{e.reason}</div>
                  </div>
                  <div className="row-amount"><span className="muted">{brl(e.amount_cents)}</span></div>
                </li>
              ))}
            </ul>
          </>
        )}
      </details>
    </Panel>
  );
}

export default function OverviewPage({ month }: { month: string }) {
  const q = useQuery({ queryKey: ['overview', month], queryFn: () => api.get<Overview>(`/overview${qs({ month })}`) });
  const [paying, setPaying] = useState<{ id: number; label: string; amount: number; income?: boolean } | null>(null);
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <ErrorBox error={q.error ?? new Error('Sem dados')} />;
  const o = q.data;
  const f = o.forecast;
  const pending = o.cash.items.filter((i) => i.status === 'pending');
  const paid = o.cash.items.filter((i) => i.status === 'paid');
  const maxCat = Math.max(1, ...o.spending.by_category.map((c) => c.realized_cents + c.planned_cents));
  const hasShared = o.spending.realized_total_cents !== o.spending.realized_mine_cents;

  return (
    <div className="stack">
      <h1>Visão de {monthLabel(month)}</h1>

      {(f.has_estimates || f.has_unconfirmed_dates) && (
        <div className="alert warn">
          <strong>Atenção:</strong> a previsão deste mês inclui{' '}
          {f.has_estimates && <b>valores estimados</b>}
          {f.has_estimates && f.has_unconfirmed_dates && ' e '}
          {f.has_unconfirmed_dates && <b>datas ainda a confirmar</b>}. Itens assim aparecem com a marca <Badge tone="warn">estimado</Badge> ou <Badge tone="warn">data a confirmar</Badge>.
        </div>
      )}

      <div className="kpis">
        <div className="kpi">
          <span className="kpi-label">Custo total do mês (minha parte)</span>
          <strong className="kpi-value">{brl(o.spending.total_mine_cents)}</strong>
          <span className="kpi-sub">
            Já gasto {brl(o.spending.realized_mine_cents)} · ainda previsto {brl(o.spending.planned_mine_cents)}
            {o.spending.estimated_count > 0 && ` · ${o.spending.estimated_count} estimado${o.spending.estimated_count > 1 ? 's' : ''}`}
            {hasShared && ` · total pago pelas contas ${brl(o.spending.realized_total_cents)}`}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Ainda vai sair da conta (caixa)</span>
          <strong className="kpi-value">{brl(o.cash.pending_cents)}</strong>
          <span className="kpi-sub">{pending.length} {pending.length === 1 ? 'item pendente' : 'itens pendentes'} · já saiu {brl(o.cash.paid_cents)}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Salário líquido do mês</span>
          <strong className="kpi-value">{brl(o.income.net_cents)}</strong>
          <span className="kpi-sub">Bruto {brl(o.income.gross_cents)} − descontos {brl(o.income.deductions_cents)}{o.income.items.some((i) => i.estimated) ? ' (estimado)' : ''}</span>
        </div>
        <div className={`kpi ${(f.projected_balance_cents ?? f.month_result_cents) < 0 ? 'negative' : 'positive'}`}>
          <span className="kpi-label">{f.projected_balance_cents !== null ? 'Saldo previsto ao fim do mês' : 'Sobra prevista do mês'}</span>
          <strong className="kpi-value">{brl(f.projected_balance_cents ?? f.month_result_cents)}</strong>
          <span className="kpi-sub">
            {f.projected_balance_cents !== null
              ? `Saldo informado ${brl(f.current_balance_cents)}${f.balance_date ? ` em ${dateBR(f.balance_date)}` : ''} + entradas − saídas pendentes`
              : f.is_current_month
                ? 'Entradas − saídas do mês. Informe o saldo das contas (Configurações) para ver o saldo.'
                : 'Entradas − saídas do mês (sem saldo, pois não é o mês atual).'}
            {(f.has_estimates || f.has_unconfirmed_dates) && ' · inclui estimativas'}
          </span>
        </div>
      </div>

      <CostBreakdown spending={o.spending} />

      {f.pending_outflows_cents > 0 && o.reimbursements.pending_month_cents > 0 && (
        <p className="muted small">
          Se todos os reembolsos pendentes deste mês chegarem ({brl(o.reimbursements.pending_month_cents)}),{' '}
          {f.projected_with_reimbursements_cents !== null
            ? <>o saldo previsto sobe para <strong>{brl(f.projected_with_reimbursements_cents)}</strong>.</>
            : <>a sobra do mês vai para <strong>{brl(f.month_result_with_reimbursements_cents)}</strong>.</>}
        </p>
      )}

      {o.attention.length > 0 && (
        <Panel title="Pendências para revisar">
          <ul className="attention">
            {o.attention.map((a) => (
              <li key={a.code}>
                <Badge tone="warn">{a.count}</Badge> {a.text}
                {a.code === 'review' && <> — <Link to={`/lancamentos?mes=${month}&revisar=1`}>ver</Link></>}
                {a.code === 'no_balance' && <> — <Link to="/configuracoes">informar saldo</Link></>}
                {a.code === 'yearly' && <> — <Link to="/configuracoes">definir mês ({o.yearly_without_month.join(', ')})</Link></>}
                {a.code === 'unlinked_payment' && <> — <Link to={`/cartoes?mes=${month}`}>vincular</Link></>}
              </li>
            ))}
          </ul>
        </Panel>
      )}

      <div className="grid2">
        <Panel title="Próximos vencimentos">
          {o.upcoming.length === 0 ? <Empty>Nada pendente neste mês. 🎉</Empty> : (
            <ul className="rows">{o.upcoming.map((i) => <FlowRow month={month} key={i.key} item={i} onPay={(x) => x.tx_id && setPaying({ id: x.tx_id, label: x.label, amount: x.amount_cents })} />)}</ul>
          )}
        </Panel>

        <Panel title="Salários e receitas">
          {o.income.items.length === 0 ? <Empty>Nenhuma receita prevista neste mês.</Empty> : (
            <ul className="rows">
              {o.income.items.map((i) => (
                <li className="row" key={i.id}>
                  <div className="row-main">
                    <strong>{i.description}</strong>
                    <div className="row-sub">
                      {i.date ? dateBR(i.date) : <Badge tone="warn">sem data</Badge>}
                      {!i.date_confirmed && i.date && <Badge tone="warn">data a confirmar</Badge>}
                      {!i.date_confirmed && !i.date && <Badge tone="warn">data a confirmar</Badge>}
                      {i.estimated && <Badge tone="warn">líquido estimado</Badge>}
                    </div>
                    {i.gross_cents !== null && (
                      <div className="row-sub muted">Bruto {brl(i.gross_cents)} − impostos/descontos {brl(i.deductions_cents)}</div>
                    )}
                  </div>
                  <div className="row-amount">
                    <strong className={i.estimated ? 'estimated' : ''}>{i.estimated ? '≈ ' : ''}{brl(i.net_cents)}</strong>
                    {i.status === 'scheduled'
                      ? <button className="btn small" onClick={() => setPaying({ id: i.id, label: i.description, amount: i.net_cents, income: true })}>Marcar recebido</button>
                      : <Badge tone="good">recebido</Badge>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel title="Contas e faturas do mês" action={<span className="muted small">pagas {brl(o.cash.paid_cents)} · pendentes {brl(o.cash.pending_cents)}</span>}>
        {o.cash.items.length === 0 ? <Empty>Sem saídas neste mês.</Empty> : (<>
          {pending.length > 0 && <><h4>Pendentes</h4><ul className="rows">{pending.map((i) => <FlowRow month={month} key={i.key} item={i} onPay={(x) => x.tx_id && setPaying({ id: x.tx_id, label: x.label, amount: x.amount_cents })} />)}</ul></>}
          {paid.length > 0 && <><h4>Pagas</h4><ul className="rows">{paid.map((i) => <FlowRow month={month} key={i.key} item={i} onPay={() => undefined} />)}</ul></>}
        </>)}
        <p className="muted small">
          Compras no cartão não aparecem aqui: o que sai da conta é o pagamento da fatura. As compras contam como gasto na data em que foram feitas.
        </p>
      </Panel>

      {(o.installments.in_month_count > 0 || o.installments.remaining_count > 0) && (
        <Panel title="Compras parceladas" action={<Link to={`/cartoes?mes=${month}`} className="small">Ver parcelas futuras</Link>}>
          <ul className="kv">
            <li><span>Parcelas deste mês ({o.installments.in_month_count}) — minha parte</span><strong>{brl(o.installments.in_month_cents)}</strong></li>
            <li><span>Ainda a cair nos meses seguintes ({o.installments.remaining_count} parcela{o.installments.remaining_count === 1 ? '' : 's'}{o.installments.last_month ? `, até ${monthShort(o.installments.last_month)}` : ''})</span><strong>{brl(o.installments.remaining_cents)}</strong></li>
          </ul>
          <p className="muted small">Parcelas projetadas são estimativas (mesmo valor da parcela anterior) até aparecerem na fatura.</p>
        </Panel>
      )}

      <div className="grid2">
        <Panel title="Gasto por categoria (minha parte)">
          {o.spending.by_category.length === 0 ? <Empty>Sem despesas neste mês.</Empty> : (
            <ul className="bars">
              {o.spending.by_category.map((c) => (
                <li key={c.name}>
                  <div className="bar-head"><span>{c.name}</span><strong>{brl(c.realized_cents + c.planned_cents)}</strong></div>
                  <div className="bar"><div className="bar-real" style={{ width: `${(c.realized_cents / maxCat) * 100}%` }} /><div className="bar-plan" style={{ width: `${(c.planned_cents / maxCat) * 100}%` }} /></div>
                  {c.planned_cents > 0 && <div className="muted small">realizado {brl(c.realized_cents)} · previsto {brl(c.planned_cents)}</div>}
                </li>
              ))}
            </ul>
          )}
          <p className="muted small">Realizado: {brl(o.spending.realized_mine_cents)} · ainda previsto: {brl(o.spending.planned_mine_cents)}{o.spending.planned_estimated_count > 0 && ` (${o.spending.planned_estimated_count} estimado${o.spending.planned_estimated_count > 1 ? 's' : ''})`}</p>
        </Panel>

        <div className="stack">
          <Panel title="Reembolsos a receber">
            {o.reimbursements.items.length === 0 ? <Empty>Nada pendente de reembolso.</Empty> : (<>
              <ul className="rows">
                {o.reimbursements.items.map((r) => (
                  <li className="row" key={r.id}>
                    <div className="row-main"><strong>{r.description}</strong><div className="row-sub">{r.shared_with ?? 'quem reembolsa não informado'} · gasto de {r.month_ref.split('-').reverse().join('/')}</div></div>
                    <div className="row-amount"><strong>{brl(r.pending_cents)}</strong></div>
                  </li>
                ))}
              </ul>
              <p className="muted small">Total a receber: {brl(o.reimbursements.pending_all_cents)}. Reembolsos não são receita e não alteram o seu gasto.</p>
            </>)}
          </Panel>

          {(o.overdraft.debt_cents > 0 || o.overdraft.costs_in_month_cents > 0 || o.overdraft.amortized_in_month_cents > 0) && (
            <Panel title="Cheque especial">
              <ul className="kv">
                <li><span>Saldo devedor (pelo saldo informado)</span><strong className="neg">{brl(o.overdraft.debt_cents)}</strong></li>
                <li><span>Juros e tarifas no mês (despesa)</span><strong>{brl(o.overdraft.costs_in_month_cents)}</strong></li>
                <li><span>Pago para reduzir a dívida (não é despesa)</span><strong>{brl(o.overdraft.amortized_in_month_cents)}</strong></li>
              </ul>
            </Panel>
          )}
        </div>
      </div>

      {paying && <MarkPaid txId={paying.id} label={paying.label} amount={paying.amount} income={paying.income} onClose={() => setPaying(null)} />}
    </div>
  );
}
