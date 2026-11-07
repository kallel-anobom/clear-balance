import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Budget } from './api';
import { Empty, ErrorBox, Loading, MoneyField, Panel } from './components';
import { brl } from './format';
import { useLookups, useRefresh } from './hooks';

/** Um teto mensal fixo por categoria de despesa, válido para todos os meses. */
export function BudgetPanel() {
  const { categories } = useLookups();
  const refresh = useRefresh();
  const budgets = useQuery({ queryKey: ['budgets'], queryFn: () => api.get<Budget[]>('/budgets') });
  const [cat, setCat] = useState('');
  const [limit, setLimit] = useState<number | null>(null);
  const save = useMutation({
    mutationFn: ({ id, cents }: { id: number; cents: number }) => api.put(`/budgets/${id}`, { limit_cents: cents }),
    onSuccess: () => { setCat(''); setLimit(null); refresh(); },
  });
  const del = useMutation({ mutationFn: (id: number) => api.del(`/budgets/${id}`), onSuccess: refresh });
  const list = budgets.data ?? [];
  const free = categories.filter((c) => c.kind === 'expense' && !list.some((b) => b.category_id === c.id));

  return (
    <Panel title="Orçamento por categoria">
      <p className="muted small">
        Defina quanto quer gastar <strong>por mês</strong> em cada categoria. O limite vale para todos os meses. Na Visão do mês, a barra avisa quando você passa de 80% (amarelo) e quando estoura (vermelho).
      </p>
      {budgets.isLoading ? <Loading /> : list.length === 0 ? <Empty>Nenhum orçamento definido.</Empty> : (
        <ul className="rows">
          {list.map((b) => (
            <li className="row" key={b.category_id}>
              <div className="row-main"><strong>{b.category_name}</strong></div>
              <div className="row-amount">
                <strong>{brl(b.limit_cents)}</strong>
                <button className="btn small danger" onClick={() => del.mutate(b.category_id)}>Remover</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {free.length > 0 && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); if (cat && limit) save.mutate({ id: Number(cat), cents: limit }); }}>
          <select aria-label="Categoria" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="">Escolha a categoria…</option>
            {free.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <MoneyField label="Limite por mês" value={limit} onChange={setLimit} />
          <button className="btn primary" type="submit" disabled={!cat || !limit || save.isPending}>Definir</button>
        </form>
      )}
      <ErrorBox error={save.error ?? del.error} />
    </Panel>
  );
}
