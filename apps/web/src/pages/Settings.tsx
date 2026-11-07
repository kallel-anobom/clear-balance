import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type Account, type ApplyResult, type AppSettings, type LearnedRule, type Recurring, type TxType } from '../api';
import { Badge, Empty, ErrorBox, Field, Loading, Modal, MoneyField, Panel } from '../components';
import { brl, dateBR, monthShort, todayISO } from '../format';
import { useLookups, useRefresh } from '../hooks';
import SecurityPanel from '../Security';

const KINDS = { checking: 'Conta corrente', savings: 'Poupança', cash: 'Dinheiro', investment: 'Investimento' } as const;
const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

function AccountForm({ account, onClose }: { account?: Account; onClose: () => void }) {
  const refresh = useRefresh();
  const [f, setF] = useState({
    name: account?.name ?? '', kind: account?.kind ?? 'checking', balance: account?.balance_cents ?? null,
    balance_date: account?.balance_date ?? '', limit: account?.overdraft_limit_cents ?? null,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name, kind: f.kind, balance_cents: f.balance,
        balance_date: f.balance !== null ? f.balance_date || todayISO() : null, overdraft_limit_cents: f.limit,
      };
      return account ? api.put(`/accounts/${account.id}`, body) : api.post('/accounts', body);
    },
    onSuccess: () => { refresh(); onClose(); },
  });
  return (
    <Modal title={account ? 'Editar conta' : 'Nova conta'} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <Field label="Nome" className="span2"><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={80} autoFocus placeholder="Ex.: Conta Itaú" /></Field>
        <Field label="Tipo"><select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as Account['kind'] })}>{Object.entries(KINDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        <MoneyField label="Saldo atual (opcional)" value={f.balance} onChange={(v) => setF({ ...f, balance: v })} allowNegative
          hint="Valor negativo = cheque especial em uso (saldo devedor). Deixe vazio se não souber — o sistema não inventa saldo." />
        <Field label="Saldo válido em"><input type="date" value={f.balance_date} onChange={(e) => setF({ ...f, balance_date: e.target.value })} disabled={f.balance === null} /></Field>
        <MoneyField label="Limite do cheque especial (opcional)" value={f.limit} onChange={(v) => setF({ ...f, limit: v })} />
        <div className="span2"><ErrorBox error={save.error} /></div>
        <div className="form-actions span2"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={save.isPending}>Salvar</button></div>
      </form>
    </Modal>
  );
}

function RecurringForm({ item, onClose }: { item?: Recurring; onClose: () => void }) {
  const { categories, accounts } = useLookups();
  const refresh = useRefresh();
  const [f, setF] = useState({
    description: item?.description ?? '', type: item?.type ?? 'expense', category_id: item?.category_id ?? null, account_id: item?.account_id ?? null,
    frequency: item?.frequency ?? 'monthly', day: item?.day_of_month ? String(item.day_of_month) : '', month_of_year: item?.month_of_year ? String(item.month_of_year) : '',
    start_month: item?.start_month ?? '', end_month: item?.end_month ?? '', total: item?.total_cents ?? null, mine: item?.my_share_cents ?? null,
    gross: item?.gross_cents ?? null, deductions: item?.deductions_cents ?? null, shared_with: item?.shared_with ?? '',
    is_estimate: item?.is_estimate ?? false, needs_review: item?.needs_review ?? false, review_note: item?.review_note ?? '', notes: item?.notes ?? '', active: item?.active ?? true,
  });
  const isIncome = f.type === 'income';
  const net = isIncome && f.gross !== null ? f.gross - (f.deductions ?? 0) : f.total;
  const [applyFuture, setApplyFuture] = useState(true);
  const [preview, setPreview] = useState<{ updated: number; removed: number } | null>(null);

  const buildBody = () => {
    if (net === null) throw new Error('Informe o valor.');
    return {
      description: f.description, type: f.type, category_id: f.category_id, account_id: f.account_id, frequency: f.frequency,
      day_of_month: f.day ? Number(f.day) : null, month_of_year: f.frequency === 'yearly' && f.month_of_year ? Number(f.month_of_year) : null,
      start_month: f.start_month || null, end_month: f.end_month || null, total_cents: net,
      my_share_cents: isIncome ? null : (f.mine ?? net), gross_cents: isIncome ? f.gross : null, deductions_cents: isIncome && f.gross !== null ? (f.deductions ?? 0) : null,
      shared_with: f.shared_with || null, is_estimate: f.is_estimate, needs_review: f.needs_review, review_note: f.review_note || null, notes: f.notes || null, active: f.active,
    };
  };
  const save = useMutation({
    mutationFn: () => {
      const body = buildBody();
      return item ? api.patch(`/recurring/${item.id}`, { ...body, apply: applyFuture ? 'future_unpaid' : 'none' }) : api.post('/recurring', body);
    },
    onSuccess: () => { refresh(); onClose(); },
  });

  // Prévia (sem salvar): quantos lançamentos já gerados seriam atualizados.
  const snapshot = JSON.stringify([f, applyFuture]);
  useEffect(() => {
    if (!item || !applyFuture) { setPreview(null); return; }
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        const res = await api.patch<{ propagated: { updated: number; removed: number } | null }>(`/recurring/${item.id}`, { ...buildBody(), apply: 'future_unpaid', dry_run: true });
        if (!cancelled) setPreview(res.propagated);
      } catch {
        if (!cancelled) setPreview(null);
      }
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot]);

  return (
    <Modal title={item ? 'Editar recorrência' : 'Nova recorrência'} onClose={onClose} wide>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="span2 muted small">Recorrências geram lançamentos <strong>previstos</strong> a cada mês, quando o mês é aberto. {item ? 'Ao salvar, você escolhe se a mudança também vale para os meses já gerados que ainda não foram pagos.' : ''}</p>
        <Field label="Descrição" className="span2"><input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required maxLength={200} /></Field>
        <Field label="Tipo"><select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as 'expense' | 'income', category_id: null })}><option value="expense">Despesa</option><option value="income">Receita (salário)</option></select></Field>
        <Field label="Frequência"><select value={f.frequency} onChange={(e) => setF({ ...f, frequency: e.target.value as 'monthly' | 'yearly' })}><option value="monthly">Todo mês</option><option value="yearly">Uma vez por ano</option></select></Field>
        <Field label="Categoria"><select value={f.category_id ?? ''} onChange={(e) => setF({ ...f, category_id: e.target.value ? Number(e.target.value) : null })}><option value="">Sem categoria</option>{categories.filter((c) => c.kind === f.type).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Conta"><select value={f.account_id ?? ''} onChange={(e) => setF({ ...f, account_id: e.target.value ? Number(e.target.value) : null })}><option value="">Não informada</option>{accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
        <Field label="Dia do vencimento/pagamento" hint="Vazio = dia não definido (aparece como “data a confirmar”)."><input type="number" min={1} max={31} value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></Field>
        {f.frequency === 'yearly' && <Field label="Mês do pagamento anual" hint="Sem mês, não entra na previsão e fica como pendência."><select value={f.month_of_year} onChange={(e) => setF({ ...f, month_of_year: e.target.value })}><option value="">Não definido</option>{MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</select></Field>}
        <Field label="Vale a partir de"><input type="month" value={f.start_month} onChange={(e) => setF({ ...f, start_month: e.target.value })} /></Field>
        <Field label="Vale até (opcional)"><input type="month" value={f.end_month} onChange={(e) => setF({ ...f, end_month: e.target.value })} /></Field>
        {isIncome ? (<>
          <MoneyField label="Salário bruto" value={f.gross} onChange={(v) => setF({ ...f, gross: v })} />
          <MoneyField label="Impostos / descontos" value={f.deductions} onChange={(v) => setF({ ...f, deductions: v })} />
          {f.gross !== null ? <div className="field"><span className="field-label">Líquido (calculado)</span><strong className="big">{brl(net)}</strong></div> : <MoneyField label="Valor líquido" value={f.total} onChange={(v) => setF({ ...f, total: v })} required />}
        </>) : (<>
          <MoneyField label="Valor total pago pela conta" value={f.total} onChange={(v) => setF({ ...f, total: v })} required />
          <MoneyField label="Minha parte" value={f.mine} onChange={(v) => setF({ ...f, mine: v })} hint={f.mine !== null && f.total !== null ? `Outras pessoas: ${brl(f.total - f.mine)}` : 'Vazio = tudo é meu.'} />
          <Field label="Dividido com"><input value={f.shared_with} onChange={(e) => setF({ ...f, shared_with: e.target.value })} maxLength={200} /></Field>
        </>)}
        <label className="check"><input type="checkbox" checked={f.is_estimate} onChange={(e) => setF({ ...f, is_estimate: e.target.checked })} /> Valor estimado</label>
        <label className="check"><input type="checkbox" checked={f.needs_review} onChange={(e) => setF({ ...f, needs_review: e.target.checked })} /> Marcar para revisar</label>
        {f.needs_review && <Field label="O que precisa revisar?" className="span2"><input value={f.review_note} onChange={(e) => setF({ ...f, review_note: e.target.value })} maxLength={500} /></Field>}
        <Field label="Observações" className="span2"><textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} maxLength={1000} /></Field>
        <label className="check span2"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativa</label>
        {item && (
          <div className="span2 boxed">
            <label className="check"><input type="checkbox" checked={applyFuture} onChange={(e) => setApplyFuture(e.target.checked)} /> Aplicar também aos meses futuros ainda não pagos (a partir do mês atual)</label>
            <p className="muted small">Lançamentos já pagos ou que você editou à mão na tela Lançamentos não são alterados.</p>
            {applyFuture && preview && (
              <p className="small">{preview.updated === 0 && preview.removed === 0 ? 'Nenhum lançamento já gerado será alterado.' : <>Isto vai atualizar <strong>{preview.updated}</strong> lançamento(s){preview.removed > 0 && <> e remover <strong>{preview.removed}</strong> que deixaram de valer</>}.</>}</p>
            )}
          </div>
        )}
        <div className="span2"><ErrorBox error={save.error} /></div>
        <div className="form-actions span2"><button type="button" className="btn" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={save.isPending}>Salvar</button></div>
      </form>
    </Modal>
  );
}

const RULE_TYPES: Record<TxType, string> = {
  expense: 'Despesa', income: 'Receita', transfer: 'Transferência entre contas', reimbursement: 'Reembolso',
  invoice_payment: 'Pagamento de fatura', overdraft_payment: 'Pagamento do cheque especial',
};

/** O que o sistema aprendeu com suas correções nas importações. Só nome de estabelecimento e classificação. */
function RulesPanel() {
  const { categories } = useLookups();
  const refresh = useRefresh();
  const rules = useQuery({ queryKey: ['rules'], queryFn: () => api.get<LearnedRule[]>('/rules') });
  const patch = useMutation({
    mutationFn: ({ id, ...body }: { id: number } & Partial<Pick<LearnedRule, 'category_id' | 'type' | 'ignore'>>) => api.patch(`/rules/${id}`, body),
    onSuccess: refresh,
  });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/rules/${id}`), onSuccess: refresh });
  const clear = useMutation({ mutationFn: () => api.del('/rules'), onSuccess: refresh });
  // Aplica as regras aos lançamentos antigos sem categoria (primeiro só conta, depois pede confirmação).
  const [applied, setApplied] = useState<string | null>(null);
  const apply = useMutation({
    mutationFn: async () => {
      const dry = await api.post<ApplyResult>('/rules/apply', { dry_run: true });
      if (dry.matched === 0) return `Nenhum dos ${dry.total_uncategorized} lançamentos sem categoria combina com as regras.`;
      const ex = dry.sample.slice(0, 5).map((s) => `• ${s.description} → ${s.category_name}${s.via === 'similar' ? ' (parecido)' : ''}`).join('\n');
      if (!confirm(`${dry.matched} de ${dry.total_uncategorized} lançamentos sem categoria serão classificados:\n\n${ex}\n\nLançamentos que já têm categoria não são alterados. Continuar?`)) return 'Cancelado. Nada foi alterado.';
      const done = await api.post<ApplyResult>('/rules/apply', { dry_run: false });
      return `${done.updated} lançamento(s) classificado(s).`;
    },
    onSuccess: (msg) => { setApplied(msg); refresh(); },
  });
  const list = rules.data ?? [];
  return (
    <Panel title="Regras aprendidas" action={list.length > 0 ? <button className="btn small danger" disabled={clear.isPending} onClick={() => confirm('Esquecer todas as regras aprendidas?') && clear.mutate()}>Esquecer tudo</button> : undefined}>
      <p className="muted small">
        Quando você corrige o tipo ou a categoria de uma linha na importação e marca “lembrar esta correção”, o sistema guarda <strong>apenas o nome do estabelecimento</strong> (sem números, datas ou valores) e a classificação escolhida, e a sugere nas próximas importações. Tudo fica na sua própria base: nada é enviado a serviços externos.
      </p>
      {list.length > 0 && (
        <div className="inline-form">
          <button className="btn" disabled={apply.isPending} onClick={() => apply.mutate()}>{apply.isPending ? 'Conferindo…' : 'Aplicar aos lançamentos antigos sem categoria'}</button>
          {applied && <span className="muted small">{applied}</span>}
        </div>
      )}
      {rules.isLoading ? <Loading /> : list.length === 0 ? <Empty>Nada aprendido ainda. Corrija uma categoria ao importar um extrato.</Empty> : (
        <ul className="rows">{list.map((r) => (
          <li className="row" key={r.id}>
            <div className="row-main">
              <strong>{r.pattern}</strong>
              <div className="row-sub">
                <Badge>{r.kind === 'card' ? 'cartão' : 'conta'}</Badge>
                <span>confirmada {r.use_count}×</span>
                {r.ignore && <Badge tone="warn">ignorar</Badge>}
              </div>
            </div>
            <div className="row-amount rule-controls">
              {r.kind === 'account' && (
                <select aria-label="Tipo" value={r.type ?? ''} onChange={(e) => patch.mutate({ id: r.id, type: (e.target.value || null) as TxType | null })}>
                  <option value="">Tipo automático</option>
                  {Object.entries(RULE_TYPES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                </select>
              )}
              {(r.type === null || r.type === 'expense' || r.type === 'income') && (
                <select aria-label="Categoria" value={r.category_id ?? ''} onChange={(e) => patch.mutate({ id: r.id, category_id: e.target.value ? Number(e.target.value) : null })}>
                  <option value="">Sem categoria</option>
                  {categories.filter((c) => r.type !== 'income' ? c.kind === 'expense' || r.type === null : c.kind === 'income').map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
              <label className="check"><input type="checkbox" checked={r.ignore} onChange={(e) => patch.mutate({ id: r.id, ignore: e.target.checked })} /> ignorar sempre</label>
              <button className="btn small danger" onClick={() => del.mutate(r.id)}>Esquecer</button>
            </div>
          </li>))}</ul>
      )}
      <ErrorBox error={patch.error ?? del.error ?? clear.error ?? apply.error} />
    </Panel>
  );
}

/** IA opcional (leitor de reserva da importação). Desligada por padrão; a chave existe só no servidor. */
function AiPanel() {
  const refresh = useRefresh();
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/settings') });
  const toggle = useMutation({ mutationFn: (v: boolean) => api.put('/settings', { ai_enabled: v }), onSuccess: refresh });
  const ai = settings.data?.ai;
  return (
    <Panel title="IA (opcional)">
      <p className="muted small">
        Quando o leitor automático não entende um extrato, você pode pedir ajuda ao Claude (Anthropic) pelo botão <strong>Tentar com IA</strong> na importação. Só então o <strong>texto</strong> do extrato é enviado, nunca o arquivo, e antes disso o servidor troca CPF/CNPJ, e-mails, telefones e números de conta ou cartão por marcadores. Nomes de estabelecimentos (e de pessoas, em PIX) seguem no texto. A IA apenas propõe linhas desmarcadas: você revisa tudo antes de salvar.
      </p>
      {!ai ? <Loading /> : (
        <>
          <label className="check">
            <input type="checkbox" checked={ai.enabled} disabled={!ai.available || toggle.isPending} onChange={(e) => toggle.mutate(e.target.checked)} /> Ligar a IA como leitor de reserva
          </label>
          <p className="small">
            {ai.available ? <Badge tone="good">chave configurada no servidor</Badge> : <Badge tone="warn">sem chave: defina ANTHROPIC_API_KEY no servidor (Vercel) e faça redeploy</Badge>}
            {' '}Usos neste mês: <strong>{ai.calls}</strong> de {ai.limit}.
          </p>
        </>
      )}
      <ErrorBox error={toggle.error} />
    </Panel>
  );
}

export default function SettingsPage() {
  const { accounts } = useLookups();
  const refresh = useRefresh();
  const [acc, setAcc] = useState<{ account?: Account } | null>(null);
  const [rec, setRec] = useState<{ item?: Recurring } | null>(null);
  const recurring = useQuery({ queryKey: ['recurring'], queryFn: () => api.get<Recurring[]>('/recurring') });
  const settings = useQuery({ queryKey: ['settings'], queryFn: () => api.get<AppSettings>('/settings') });
  const summary = useQuery({ queryKey: ['summary'], queryFn: () => api.get<Record<string, number>>('/data/summary') });
  const [names, setNames] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');

  const saveNames = useMutation({
    mutationFn: () => api.put('/settings', { own_transfer_names: (names ?? '').split(',').map((s) => s.trim()).filter(Boolean) }),
    onSuccess: () => { setNames(null); refresh(); },
  });
  const delAcc = useMutation({ mutationFn: (id: number) => api.del(`/accounts/${id}`), onSuccess: refresh });
  const delRec = useMutation({ mutationFn: (id: number) => api.del(`/recurring/${id}`), onSuccess: refresh });
  const delImports = useMutation({ mutationFn: () => api.del('/data/imports'), onSuccess: refresh });
  const wipe = useMutation({ mutationFn: () => api.post('/data/wipe', { confirm: 'APAGAR TUDO' }), onSuccess: () => { setConfirmText(''); refresh(); } });

  return (
    <div className="stack">
      <h1>Configurações</h1>

      <SecurityPanel />

      <Panel title="Contas e saldos" action={<button className="btn small primary" onClick={() => setAcc({})}>+ Nova conta</button>}>
        <p className="muted small">O saldo é <strong>informado por você</strong>; o sistema não inventa saldos. Saldo negativo = cheque especial em uso (dívida). Sem saldo, a visão do mês mostra só a sobra (entradas − saídas).</p>
        {accounts.length === 0 ? <Empty>Nenhuma conta cadastrada.</Empty> : (
          <ul className="rows">{accounts.map((a) => (
            <li className="row" key={a.id}>
              <div className="row-main"><strong>{a.name}</strong><div className="row-sub">{KINDS[a.kind]}{a.overdraft_limit_cents != null && ` · limite do cheque especial ${brl(a.overdraft_limit_cents)}`}</div></div>
              <div className="row-amount">
                {a.balance_cents === null ? <Badge tone="warn">saldo não informado</Badge> : <><strong className={a.balance_cents < 0 ? 'neg' : ''}>{brl(a.balance_cents)}</strong><small className="muted">{a.balance_cents < 0 ? 'saldo devedor · ' : ''}em {dateBR(a.balance_date)}</small></>}
                <div className="tx-actions"><button className="btn small" onClick={() => setAcc({ account: a })}>Editar</button><button className="btn small danger" onClick={() => confirm(`Apagar a conta "${a.name}"? Os lançamentos ficam, sem conta.`) && delAcc.mutate(a.id)}>Apagar</button></div>
              </div>
            </li>))}</ul>
        )}
        <ErrorBox error={delAcc.error} />
      </Panel>

      <Panel title="Dados iniciais e recorrências" action={<button className="btn small primary" onClick={() => setRec({})}>+ Nova</button>}>
        <p className="muted small">Contas e salários que se repetem. Tudo pode ser corrigido. Itens com <Badge tone="warn">estimado</Badge> ou <Badge tone="warn">revisar</Badge> ainda não foram confirmados.</p>
        {recurring.isLoading ? <Loading /> : (
          <ul className="rows">{(recurring.data ?? []).map((r) => (
            <li className="row" key={r.id}>
              <div className="row-main">
                <strong>{r.description}</strong>
                <div className="row-sub">
                  <Badge>{r.type === 'income' ? 'receita' : 'despesa'}</Badge>
                  <Badge tone={r.frequency === 'yearly' ? 'info' : 'neutral'}>{r.frequency === 'yearly' ? `anual${r.month_of_year ? ` (${MONTHS[r.month_of_year - 1]})` : ' — mês não definido'}` : 'mensal'}</Badge>
                  {r.day_of_month ? `dia ${r.day_of_month}` : <Badge tone="warn">dia não definido</Badge>}
                  {r.start_month && <span>desde {monthShort(r.start_month)}</span>}
                  {r.is_estimate && <Badge tone="warn">estimado</Badge>}
                  {r.needs_review && <Badge tone="bad" title={r.review_note ?? ''}>revisar</Badge>}
                  {!r.active && <Badge>inativa</Badge>}
                </div>
                {r.type === 'income' && r.gross_cents !== null && <div className="row-sub muted">Bruto {brl(r.gross_cents)} − impostos/descontos {brl(r.deductions_cents)}</div>}
                {r.type === 'expense' && r.my_share_cents !== null && r.my_share_cents !== r.total_cents && <div className="row-sub muted">Total {brl(r.total_cents)} · minha parte {brl(r.my_share_cents)}</div>}
                {r.needs_review && r.review_note && <div className="tx-note">⚠ {r.review_note}</div>}
              </div>
              <div className="row-amount">
                <strong>{brl(r.type === 'income' ? r.total_cents : (r.my_share_cents ?? r.total_cents))}</strong>
                <div className="tx-actions"><button className="btn small" onClick={() => setRec({ item: r })}>Editar</button><button className="btn small danger" onClick={() => confirm(`Apagar a recorrência "${r.description}"? Lançamentos já gerados permanecem.`) && delRec.mutate(r.id)}>Apagar</button></div>
              </div>
            </li>))}</ul>
        )}
        <ErrorBox error={delRec.error} />
      </Panel>

      <Panel title="Transferências entre minhas contas">
        <p className="muted small">Se a descrição de um lançamento importado contiver um destes nomes (ex.: PIX para “Fulano de Tal”), ele é sugerido como <strong>transferência</strong> — que não conta como gasto nem receita. Separe os nomes por vírgula.</p>
        <div className="inline-form">
          <input value={names ?? (settings.data?.own_transfer_names ?? []).join(', ')} onChange={(e) => setNames(e.target.value)} aria-label="Nomes" />
          <button className="btn primary" disabled={names === null || saveNames.isPending} onClick={() => saveNames.mutate()}>Salvar</button>
        </div>
        <ErrorBox error={saveNames.error} />
      </Panel>

      <RulesPanel />

      <AiPanel />

      <Panel title="Privacidade e dados">
        <ul className="plain">
          <li>Os dados ficam no <strong>PostgreSQL</strong> (local, ou no seu projeto Supabase quando hospedado) e só são acessíveis depois do login. Nenhum dado é enviado a serviços de terceiros além do seu próprio banco.</li>
          <li>O sistema <strong>não guarda</strong> senhas bancárias, tokens, CVV nem número completo de cartão (apenas os 4 últimos dígitos, se você informar).</li>
          <li>A <strong>IA opcional</strong> fica desligada até você ligar; ao usá-la, só o texto anonimizado do extrato vai à Anthropic.</li>
          <li>As <strong>regras aprendidas</strong> guardam só o nome do estabelecimento e a classificação que você escolheu, nunca valores, datas ou o texto do extrato.</li>
          <li>Arquivos importados (CSV/PDF) não são armazenados e o conteúdo deles não vai para os logs; só os lançamentos aprovados são salvos.</li>
        </ul>
        {summary.data && <p className="muted small">Hoje: {summary.data.transactions} lançamentos ({summary.data.imported_transactions} importados), {summary.data.accounts} contas, {summary.data.cards} cartões, {summary.data.invoices} faturas.</p>}
        <h4>Backup local</h4>
        <p className="small">No terminal, na pasta do projeto: <code>npm run db:backup</code> cria um arquivo em <code>backups/</code>. Para restaurar: <code>npm run db:restore -- backups/arquivo.sql</code>. Guarde a pasta <code>backups/</code> em local seguro (ela contém seus dados financeiros).</p>
        <h4>Apagar dados</h4>
        <div className="tx-actions">
          <button className="btn danger" disabled={!summary.data?.import_batches} onClick={() => confirm('Apagar TODOS os lançamentos criados por importações? O que foi digitado à mão permanece.') && delImports.mutate()}>Apagar tudo que foi importado</button>
        </div>
        <ErrorBox error={delImports.error} />
        <div className="danger-zone">
          <p className="small"><strong>Apagar todos os dados</strong> (contas, cartões, faturas, lançamentos, recorrências e regras aprendidas). Não dá para desfazer — faça um backup antes. Digite <code>APAGAR TUDO</code> para confirmar:</p>
          <div className="inline-form">
            <input value={confirmText} onChange={(e) => setConfirmText(e.target.value)} placeholder="APAGAR TUDO" aria-label="Confirmação" />
            <button className="btn danger" disabled={confirmText !== 'APAGAR TUDO' || wipe.isPending} onClick={() => wipe.mutate()}>Apagar tudo</button>
          </div>
          <ErrorBox error={wipe.error} />
        </div>
      </Panel>

      {acc && <AccountForm account={acc.account} onClose={() => setAcc(null)} />}
      {rec && <RecurringForm item={rec.item} onClose={() => setRec(null)} />}
    </div>
  );
}
