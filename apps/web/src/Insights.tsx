import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, qs, type AppSettings, type CostComparison, type InvoiceEstimate, type MonthSummary, type OutlookMonth, type OutlookResponse, type Subscription, type SubscriptionsResponse } from './api';
import { Badge, Empty, ErrorBox, Loading, Panel } from './components';
import { brl, addMonths, dateBR, monthLabel, monthShort } from './format';
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

/** Resumo do mês escrito por IA. Só aparece com a IA ligada; a IA recebe apenas totais já calculados, nunca descrições. */
export function SummaryPanel({ month }: { month: string }) {
  const refresh = useRefresh();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/settings') });
  const gen = useMutation({
    mutationFn: () => api.post<MonthSummary>(`/overview/summary${qs({ month })}`),
    // Atualiza o contador de usos da IA (o resumo em si fica só nesta tela).
    onSettled: () => refresh(),
  });
  const ai = settings.data?.ai;
  if (!ai?.enabled || !ai.available) return null;
  const left = Math.max(0, ai.limit - ai.calls);
  const r = gen.data && gen.data.month === month ? gen.data : null;
  return (
    <Panel title="Resumo do mês com IA" action={<span className="muted small">{ai.calls} de {ai.limit} usos da IA neste mês</span>}>
      {!r && (
        <>
          <p className="muted small">
            A IA escreve um resumo curto a partir de <strong>totais por categoria, orçamento e comparação com os meses anteriores</strong>. Não são enviados descrições de lançamentos, datas, nomes de estabelecimentos, contas ou cartões. Os números são calculados pelo sistema e o texto é descartado se citar algum valor que não esteja nos seus dados. Cada resumo conta 1 uso do limite mensal.
          </p>
          <div className="inline-form">
            <button className="btn primary" disabled={gen.isPending || left === 0} onClick={() => gen.mutate()}>
              {gen.isPending ? 'Gerando…' : left === 0 ? 'Limite de usos atingido' : 'Gerar resumo do mês'}
            </button>
          </div>
        </>
      )}
      <ErrorBox error={gen.error} />
      {r && (
        <>
          <p>{r.resumo}</p>
          {r.destaques.length > 0 && <><h4 className="subhead">Destaques</h4><ul className="plain">{r.destaques.map((d) => <li key={d}>{d}</li>)}</ul></>}
          {r.sugestoes.length > 0 && <><h4 className="subhead">Sugestões</h4><ul className="plain">{r.sugestoes.map((d) => <li key={d}>{d}</li>)}</ul></>}
          <p className="muted small">Texto escrito por IA ({r.model}) a partir de números calculados pelo sistema. Confira com os lançamentos antes de decidir algo.</p>
          <details>
            <summary className="muted small">O que foi enviado à IA</summary>
            <ul className="kv">{r.facts.map((f) => <li key={f.label}><span>{f.label}</span><strong>{f.value}</strong></li>)}</ul>
          </details>
          <div className="inline-form"><button className="btn small" onClick={() => gen.reset()}>Fechar</button></div>
        </>
      )}
    </Panel>
  );
}

const BASIS_TEXT: Record<InvoiceEstimate['basis'], string> = {
  confirmed: 'total confirmado',
  closed: 'fatura fechada',
  estimate: 'estimada pela média das faturas anteriores',
  launched_only: 'só o que está lançado (sem histórico para estimar)',
};

function OutlookInvoice({ inv }: { inv: InvoiceEstimate }) {
  const estimated = inv.basis === 'estimate';
  return (
    <li className="row">
      <div className="row-main">
        <strong>Fatura {inv.card_name}</strong>
        <div className="row-sub">
          <span>vence {dateBR(inv.due_date)}</span>
          <Badge tone={estimated || inv.basis === 'launched_only' ? 'warn' : 'good'}>{BASIS_TEXT[inv.basis]}</Badge>
          {inv.is_stale && (
            <Badge tone="warn" title="Reenvie a fatura aberta em Importação para atualizar o valor">
              {inv.stale_days === null ? 'sem compras lançadas ainda' : `última compra lançada há ${inv.stale_days} dias`}
            </Badge>
          )}
        </div>
        <div className="muted small">
          Lançado {brl(inv.committed_cents)}
          {inv.fixed_cents > 0 && <> (inclui {brl(inv.fixed_cents)} de parcelas e recorrências)</>}
          {estimated && inv.avg_variable_cents !== null && <> · média das compras de {inv.history_count} fatura{inv.history_count > 1 ? 's' : ''} anterior{inv.history_count > 1 ? 'es' : ''}: {brl(inv.avg_variable_cents)}</>}
        </div>
      </div>
      <div className="row-amount">
        <strong className={estimated ? 'estimated' : ''}>{estimated ? '≈ ' : ''}{brl(inv.estimated_cents)}</strong>
        {inv.basis !== 'confirmed' && inv.basis !== 'closed' && <Link className="btn small" to={`/importar?cartao=${inv.card_id}`}>Atualizar fatura</Link>}
      </div>
    </li>
  );
}

function OutlookCard({ m }: { m: OutlookMonth }) {
  const differs = m.estimated_cents !== m.committed_cents;
  return (
    <div className="kpi">
      <span className="kpi-label">{m.is_current ? `Ainda falta pagar em ${monthLabel(m.month)}` : `A pagar em ${monthLabel(m.month)}`}</span>
      <strong className="kpi-value">{differs ? '≈ ' : ''}{brl(m.estimated_cents)}</strong>
      <span className="kpi-sub">
        {differs ? `Já lançado: ${brl(m.committed_cents)} · o resto é estimativa` : 'Tudo já lançado ou confirmado'}
        {m.is_current && m.paid_cents > 0 && ` · já saiu ${brl(m.paid_cents)}`}
      </span>
      {m.stale_count > 0 && <span className="kpi-sub"><Badge tone="warn">{m.stale_count} fatura{m.stale_count > 1 ? 's' : ''} desatualizada{m.stale_count > 1 ? 's' : ''}</Badge></span>}
    </div>
  );
}

function OutlookDetails({ m }: { m: OutlookMonth }) {
  return (
    <details className="cost-details">
      <summary className="muted small">{m.is_current ? `Ver de onde vem o que falta em ${monthLabel(m.month)}` : `Ver de onde vem ${monthLabel(m.month)}`}</summary>
        {m.invoices.length > 0 && <ul className="rows">{m.invoices.map((i) => <OutlookInvoice key={`${i.card_id}-${i.due_date}`} inv={i} />)}</ul>}
        {m.other_items.length > 0 && (
          <>
            <h4 className="subhead">Contas e outras saídas pendentes · {brl(m.other_cents)}</h4>
            <ul className="rows">
              {m.other_items.map((i) => (
                <li className="row" key={i.key}>
                  <div className="row-main"><strong>{i.label}</strong><div className="row-sub">{i.date ? dateBR(i.date) : <Badge tone="warn">sem data</Badge>}{i.estimated && <Badge tone="warn">estimado</Badge>}</div></div>
                  <div className="row-amount"><strong>{i.estimated ? '≈ ' : ''}{brl(i.amount_cents)}</strong></div>
                </li>
              ))}
            </ul>
          </>
        )}
        {m.invoices.length === 0 && m.other_items.length === 0 && <Empty>Nada previsto para este mês.</Empty>}
    </details>
  );
}

/** Quanto vai sair da conta nos próximos meses: o que já está nas faturas e a estimativa ao fechar. */
export function OutlookPanel() {
  const q = useQuery({ queryKey: ['outlook'], queryFn: () => api.get<OutlookResponse>('/overview/outlook?months=3') });
  if (q.isLoading) return <Panel title="Quanto vou pagar nos próximos meses"><Loading /></Panel>;
  if (q.error || !q.data) return <Panel title="Quanto vou pagar nos próximos meses"><ErrorBox error={q.error ?? new Error('Sem dados')} /></Panel>;
  return (
    <Panel title="Quanto vou pagar nos próximos meses">
      <div className="kpis">{q.data.months.map((m) => <OutlookCard key={m.month} m={m} />)}</div>
      {q.data.months.map((m) => <OutlookDetails key={m.month} m={m} />)}
      <p className="muted small">
        Conta o que <strong>sai da conta</strong> em cada mês: faturas que vencem nele (inclusive compras de meses anteriores) mais contas e recorrências pendentes. A parte estimada é a média das compras das últimas 3 faturas fechadas de cada cartão, nunca abaixo do que já foi lançado, e não adivinha compras grandes ou de época (como as de fim de ano). Para atualizar, reenvie a fatura aberta em Importação.
      </p>
    </Panel>
  );
}
