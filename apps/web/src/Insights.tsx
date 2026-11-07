import { useMutation, useQuery } from '@tanstack/react-query';
import { api, qs, type CostComparison, type Subscription, type SubscriptionsResponse } from './api';
import { Badge, Empty, ErrorBox, Loading, Panel } from './components';
import { brl, addMonths, monthShort } from './format';
import { useRefresh } from './hooks';

const pctText = (p: number | null) => (p === null ? 'novo' : `${p > 0 ? '+' : ''}${p.toLocaleString('pt-BR')}%`);
const signed = (c: number) => `${c > 0 ? '+' : c < 0 ? '−' : ''}${brl(Math.abs(c))}`;

/** Custo do mês contra a média dos meses anteriores, com as categorias que mais subiram. */
export function ComparePanel({ month }: { month: string }) {
  const q = useQuery({ queryKey: ['compare', month], queryFn: () => api.get<CostComparison>(`/overview/compare${qs({ month })}`) });
  if (q.isLoading) return <Panel title="Comparado aos últimos meses"><Loading /></Panel>;
  if (q.error || !q.data) return <Panel title="Comparado aos últimos meses"><ErrorBox error={q.error ?? new Error('Sem dados')} /></Panel>;
  const c = q.data;
  if (!c.available) {
    return <Panel title="Comparado aos últimos meses"><Empty>Ainda não há meses anteriores com gastos para comparar.</Empty></Panel>;
  }
  const up = c.diff_cents > 0;
  return (
    <Panel title="Comparado aos últimos meses">
      <ul className="kv">
        <li><span>Custo deste mês</span><strong>{brl(c.current_cents)}</strong></li>
        <li><span>Média de {c.months_used.length} {c.months_used.length === 1 ? 'mês anterior' : 'meses anteriores'} ({c.months_used.map(monthShort).join(', ')})</span><strong>{brl(c.avg_cents)}</strong></li>
        <li>
          <span>Diferença</span>
          <strong className={up ? 'neg' : ''}>{signed(c.diff_cents)} ({pctText(c.diff_pct)})</strong>
        </li>
      </ul>
      {c.partial && <p className="muted small">Só {c.months_used.length} {c.months_used.length === 1 ? 'mês anterior tem' : 'meses anteriores têm'} gastos, então a média ainda é pouco confiável.</p>}
      {c.top_increases.length > 0 && (
        <>
          <h4 className="subhead">O que mais subiu</h4>
          <ul className="rows">
            {c.top_increases.map((i) => (
              <li className="row" key={`${i.category_id}-${i.name}`}>
                <div className="row-main">
                  <strong>{i.name}</strong>
                  <div className="row-sub">{brl(i.current_cents)} agora · média {brl(i.avg_cents)}</div>
                </div>
                <div className="row-amount"><strong className="neg">{signed(i.diff_cents)}</strong><Badge tone="warn">{pctText(i.diff_pct)}</Badge></div>
              </li>
            ))}
          </ul>
        </>
      )}
      <p className="muted small">A média usa só meses que têm gastos. Compras parceladas e previstos entram como no custo do mês.</p>
    </Panel>
  );
}

function SubscriptionRow({ s, nextMonth }: { s: Subscription; nextMonth: string }) {
  const refresh = useRefresh();
  const create = useMutation({
    mutationFn: () =>
      api.post('/recurring', {
        ...s.draft, type: 'expense', frequency: 'monthly', start_month: nextMonth, is_estimate: false,
      }),
    onSuccess: refresh,
  });
  return (
    <li className="row">
      <div className="row-main">
        <strong>{s.description}</strong>
        <div className="row-sub">
          <span>{s.months_count} meses seguidos · última em {monthShort(s.last_month)}</span>
          {s.price_change_cents !== 0 && (
            <Badge tone={s.price_change_cents > 0 ? 'warn' : 'good'} title="Variação entre a primeira e a última cobrança">
              {s.price_change_cents > 0 ? 'subiu' : 'caiu'} {brl(Math.abs(s.price_change_cents))}{s.price_change_pct !== null ? ` (${pctText(s.price_change_pct)})` : ''}
            </Badge>
          )}
        </div>
        <ErrorBox error={create.error} />
      </div>
      <div className="row-amount">
        <strong>{brl(s.last_cents)}</strong>
        <small className="muted">≈ {brl(s.yearly_estimate_cents)} por ano</small>
        <button className="btn small" disabled={create.isPending || create.isSuccess} onClick={() => create.mutate()}
          title="Cria uma recorrência mensal a partir do mês que vem, para entrar na previsão">
          {create.isSuccess ? 'Recorrência criada' : 'Criar recorrência'}
        </button>
      </div>
    </li>
  );
}

/** Cobranças que se repetem todo mês e ainda não estão cadastradas como recorrência. */
export function SubscriptionsPanel({ month }: { month: string }) {
  const q = useQuery({ queryKey: ['subscriptions'], queryFn: () => api.get<SubscriptionsResponse>('/subscriptions') });
  if (q.isLoading || q.error || !q.data) return q.error ? <ErrorBox error={q.error} /> : null;
  const { items, total_monthly_cents } = q.data;
  if (items.length === 0) return null;
  const nextMonth = addMonths(month, 1);
  return (
    <Panel title="Assinaturas e cobranças que se repetem" action={<span className="muted small">≈ {brl(total_monthly_cents)} por mês</span>}>
      <p className="muted small">
        Encontradas nos seus lançamentos: mesmo estabelecimento, valor parecido, 3 meses seguidos ou mais. Parcelas e o que já é recorrência não aparecem aqui. Confira se ainda usa cada uma.
      </p>
      <ul className="rows">{items.map((s) => <SubscriptionRow key={s.merchant} s={s} nextMonth={nextMonth} />)}</ul>
    </Panel>
  );
}
