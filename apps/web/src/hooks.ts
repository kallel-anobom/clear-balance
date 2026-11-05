import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api, type Account, type Card, type Category } from './api';
import { currentMonth } from './format';

/** Mês selecionado, guardado na URL (?mes=2026-11) para poder voltar e compartilhar o link. */
export function useMonth(): [string, (m: string) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('mes');
  const month = raw && /^\d{4}-\d{2}$/.test(raw) ? raw : currentMonth();
  const set = (m: string) => {
    const next = new URLSearchParams(params);
    next.set('mes', m);
    setParams(next, { replace: true });
  };
  return [month, set];
}

export function useLookups() {
  const accounts = useQuery({ queryKey: ['accounts'], queryFn: () => api.get<Account[]>('/accounts') });
  const cards = useQuery({ queryKey: ['cards'], queryFn: () => api.get<Card[]>('/cards') });
  const categories = useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories') });
  return {
    accounts: accounts.data ?? [],
    cards: cards.data ?? [],
    categories: categories.data ?? [],
    loading: accounts.isLoading || cards.isLoading || categories.isLoading,
  };
}

/** Depois de qualquer alteração, recarrega todos os dados exibidos. */
export function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries();
}
