import { merchantKey } from '../importer/classify.js';
import { addMonths } from '../lib.js';

export interface SubTx {
  id: number;
  description: string;
  total_cents: number;
  my_share_cents: number | null;
  month_ref: string;
  occurred_on?: string | null;
  paid_on?: string | null;
  installment_group?: string | null;
  recurring_id?: number | null;
  is_projected?: boolean;
  category_id: number | null;
  account_id: number | null;
}

export interface Subscription {
  /** Nome normalizado do estabelecimento (o mesmo das regras aprendidas). */
  merchant: string;
  description: string;
  typical_cents: number;
  last_cents: number;
  last_month: string;
  months: string[];
  months_count: number;
  /** Variação entre a primeira e a última cobrança da série. */
  price_change_cents: number;
  price_change_pct: number | null;
  yearly_estimate_cents: number;
  /** Rascunho para criar a recorrência com um clique. */
  draft: { description: string; total_cents: number; category_id: number | null; account_id: number | null; day_of_month: number | null };
}

export const MIN_MONTHS = 3;
/** Cobranças da mesma série variam no máximo isto em relação à mediana (reajustes pequenos). */
const AMOUNT_TOLERANCE = 0.15;

const mine = (t: SubTx) => t.my_share_cents ?? t.total_cents;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

/** Maior sequência de meses consecutivos que termina o mais tarde possível. */
function bestRun(months: string[]): string[] {
  const sorted = [...new Set(months)].sort();
  let best: string[] = [];
  let run: string[] = [];
  for (const m of sorted) {
    run = run.length && addMonths(run[run.length - 1], 1) === m ? [...run, m] : [m];
    if (run.length >= best.length) best = run;
  }
  return best;
}

/**
 * Detecta cobranças recorrentes que você talvez nem lembre (assinaturas): o mesmo estabelecimento, com valor
 * parecido, em pelo menos 3 meses seguidos, ainda ativa no mês atual ou no anterior.
 * Ignora parcelas, itens previstos, lançamentos já gerados por recorrência e estabelecimentos que já têm recorrência.
 */
export function detectSubscriptions(txs: SubTx[], opts: { currentMonth: string; recurringDescriptions: string[] }): Subscription[] {
  const known = opts.recurringDescriptions.map(merchantKey).filter(Boolean);
  const isKnown = (key: string) => known.some((k) => key === k || key.startsWith(`${k} `) || k.startsWith(`${key} `));

  const groups = new Map<string, SubTx[]>();
  for (const t of txs) {
    if (t.installment_group || t.recurring_id || t.is_projected || mine(t) <= 0) continue;
    const key = merchantKey(t.description);
    if (!key || isKnown(key)) continue;
    groups.set(key, [...(groups.get(key) ?? []), t]);
  }

  const out: Subscription[] = [];
  for (const [merchant, list] of groups) {
    // Valores da série: perto da mediana de todas as cobranças (compras avulsas de outro valor ficam de fora).
    const med = median(list.map(mine));
    const inSeries = list.filter((t) => Math.abs(mine(t) - med) <= med * AMOUNT_TOLERANCE);
    // Várias cobranças no mesmo mês (ex.: corridas, mercado) não é assinatura.
    const perMonth = new Map<string, SubTx[]>();
    for (const t of inSeries) perMonth.set(t.month_ref, [...(perMonth.get(t.month_ref) ?? []), t]);
    const months = [...perMonth.keys()];
    const repeated = months.filter((m) => perMonth.get(m)!.length > 1).length;
    if (repeated > months.length / 2) continue;

    const run = bestRun(months);
    const last = run[run.length - 1];
    if (run.length < MIN_MONTHS || last < addMonths(opts.currentMonth, -1)) continue;

    const series = run.map((m) => perMonth.get(m)![0]);
    const first = series[0];
    const latest = series[series.length - 1];
    const typical = median(series.map(mine));
    const change = mine(latest) - mine(first);
    const lastDate = latest.paid_on ?? latest.occurred_on ?? null;
    out.push({
      merchant,
      description: latest.description,
      typical_cents: typical,
      last_cents: mine(latest),
      last_month: last,
      months: run,
      months_count: run.length,
      price_change_cents: change,
      price_change_pct: mine(first) > 0 ? Math.round((change / mine(first)) * 1000) / 10 : null,
      yearly_estimate_cents: typical * 12,
      draft: {
        description: latest.description,
        total_cents: mine(latest),
        category_id: latest.category_id,
        account_id: latest.account_id,
        day_of_month: lastDate ? Number(lastDate.slice(8, 10)) : null,
      },
    });
  }
  return out.sort((a, b) => b.typical_cents - a.typical_cents);
}
