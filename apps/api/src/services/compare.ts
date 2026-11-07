import { addMonths } from '../lib.js';

/** O que a comparação precisa de cada mês (subconjunto do resultado de computeOverview). */
export interface MonthCost {
  month: string;
  total_mine_cents: number;
  by_category: { category_id: number | null; name: string; used_cents: number }[];
}

export interface CategoryComparison {
  category_id: number | null;
  name: string;
  current_cents: number;
  avg_cents: number;
  diff_cents: number;
  /** null quando a média é zero (não existe base para comparar). */
  diff_pct: number | null;
}

export interface CostComparison {
  month: string;
  available: boolean;
  current_cents: number;
  months_used: string[];
  /** true quando há menos de 3 meses anteriores com gastos. */
  partial: boolean;
  avg_cents: number;
  diff_cents: number;
  diff_pct: number | null;
  categories: CategoryComparison[];
  top_increases: CategoryComparison[];
}

export const COMPARE_MONTHS = 3;

export function previousMonths(month: string, n = COMPARE_MONTHS): string[] {
  return Array.from({ length: n }, (_, i) => addMonths(month, -(i + 1)));
}

const pct = (diff: number, base: number) => (base > 0 ? Math.round((diff / base) * 1000) / 10 : null);

/**
 * Compara o custo do mês com a média dos meses anteriores QUE TÊM gastos (até 3).
 * Mês sem nenhum gasto não entra na média (senão ela seria artificialmente baixa).
 */
export function compareCosts(current: MonthCost, previous: MonthCost[]): CostComparison {
  const used = previous.filter((m) => m.total_mine_cents > 0);
  const n = used.length;
  const base = {
    month: current.month,
    current_cents: current.total_mine_cents,
    months_used: used.map((m) => m.month),
    partial: n < COMPARE_MONTHS,
  };
  if (n === 0) {
    return { ...base, available: false, avg_cents: 0, diff_cents: 0, diff_pct: null, categories: [], top_increases: [] };
  }

  const avg = Math.round(used.reduce((s, m) => s + m.total_mine_cents, 0) / n);
  const key = (c: { category_id: number | null; name: string }) => `${c.category_id ?? 'x'}:${c.name}`;
  const names = new Map<string, { category_id: number | null; name: string }>();
  const cur = new Map<string, number>();
  const prev = new Map<string, number>();
  for (const c of current.by_category) { names.set(key(c), c); cur.set(key(c), c.used_cents); }
  for (const m of used) {
    for (const c of m.by_category) {
      names.set(key(c), c);
      prev.set(key(c), (prev.get(key(c)) ?? 0) + c.used_cents);
    }
  }
  const categories: CategoryComparison[] = [...names.entries()]
    .map(([k, c]) => {
      const current_cents = cur.get(k) ?? 0;
      const avg_cents = Math.round((prev.get(k) ?? 0) / n);
      const diff_cents = current_cents - avg_cents;
      return { category_id: c.category_id, name: c.name, current_cents, avg_cents, diff_cents, diff_pct: pct(diff_cents, avg_cents) };
    })
    .filter((c) => c.current_cents !== 0 || c.avg_cents !== 0)
    .sort((a, b) => b.diff_cents - a.diff_cents);

  return {
    ...base,
    available: true,
    avg_cents: avg,
    diff_cents: current.total_mine_cents - avg,
    diff_pct: pct(current.total_mine_cents - avg, avg),
    categories,
    top_increases: categories.filter((c) => c.diff_cents > 0).slice(0, 3),
  };
}
