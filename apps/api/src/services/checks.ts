import type { OutlookMonth } from './outlook.js';
import { formatBRL } from './summary.js';

/**
 * Conferência dos números: checagens determinísticas (sem IA) que apontam onde o valor exibido pode estar errado.
 * Função pura: os dados chegam de `checksData.ts`. Cada alerta diz o que foi visto e o que fazer.
 */

export type CheckLevel = 'bad' | 'warn' | 'info';

export interface Check {
  code: string;
  level: CheckLevel;
  title: string;
  detail: string;
  /** Link da tela onde dá para resolver. */
  action?: { label: string; to: string };
}

export interface InvoiceCheckRow {
  id: number;
  card_id: number;
  card_name: string;
  due_date: string;
  statement_total_cents: number | null;
  paid_on: string | null;
  /** Soma das compras lançadas na fatura (despesas). */
  lines_total_cents: number;
  lines_count: number;
}

export interface DuplicateGroup {
  occurred_on: string;
  card_name: string;
  total_cents: number;
  count: number;
}

export interface CheckInput {
  month: string;
  today: string;
  outlook: OutlookMonth;
  /** Faturas com vencimento no mês (pagas ou não). */
  invoices: InvoiceCheckRow[];
  /** "Ainda vai sair da conta" da visão do mês (deve bater com o lançado da previsão). */
  overview_pending_cents: number;
  income_cents: number;
  scheduled_income_cents: number;
  uncategorized: { count: number; total_cents: number };
  duplicates: DuplicateGroup[];
  /** Limite de saída do mês definido pelo usuário (Configurações); null = sem alerta de limite. */
  limit_cents?: number | null;
}

export interface ChecksResult {
  month: string;
  checks: Check[];
  /** Quantas verificações rodaram e quantas passaram sem alerta. */
  total: number;
  passed: number;
  /** Quanto do valor previsto de saída do mês já está lançado ou confirmado (0 a 100). */
  certain_pct: number | null;
}

const dm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const OUTLIER_FACTOR = 1.5;
const OUTLIER_MIN_CENTS = 50_000;

export function computeChecks(input: CheckInput): ChecksResult {
  const { month, today, outlook } = input;
  const checks: Check[] = [];
  const run = { n: 0 };
  const raise = (c: Check) => checks.push(c);

  // 1. Total confirmado × soma das compras (importação incompleta ou duplicada).
  run.n++;
  for (const i of input.invoices) {
    if (i.statement_total_cents === null || i.lines_count === 0) continue;
    const diff = i.lines_total_cents - i.statement_total_cents;
    if (Math.abs(diff) <= 1) continue;
    raise({
      code: 'invoice_sum_mismatch',
      level: 'bad',
      title: `Fatura ${i.card_name} (vence ${dm(i.due_date)}): a soma das compras não bate com o total`,
      detail: `As compras somam ${formatBRL(i.lines_total_cents)} e o total confirmado é ${formatBRL(i.statement_total_cents)} (${diff > 0 ? 'sobram' : 'faltam'} ${formatBRL(diff)}). ${
        diff > 0 ? 'Pode haver compra repetida ou crédito que não entrou.' : 'Pode faltar importar compras.'
      }`,
      action: { label: 'Ver a fatura', to: '/cartoes' },
    });
  }

  // 2. Fatura com soma negativa: pagamento ou crédito entrou como compra.
  run.n++;
  for (const i of input.invoices) {
    if (i.statement_total_cents !== null || i.lines_total_cents >= 0) continue;
    raise({
      code: 'invoice_negative',
      level: 'bad',
      title: `Fatura ${i.card_name} (vence ${dm(i.due_date)}) está negativa`,
      detail: `A soma das compras é ${formatBRL(i.lines_total_cents)}. Um pagamento ou crédito provavelmente entrou como compra; confira as linhas dessa fatura.`,
      action: { label: 'Ver a fatura', to: '/cartoes' },
    });
  }

  // 3. Fatura vencida sem pagamento registrado.
  run.n++;
  for (const i of input.invoices) {
    if (i.paid_on !== null || i.due_date >= today) continue;
    raise({
      code: 'invoice_overdue',
      level: 'warn',
      title: `Fatura ${i.card_name} venceu em ${dm(i.due_date)} e está sem pagamento registrado`,
      detail: 'Se você já pagou, importe o extrato da conta ou marque como paga, para ela sair do "ainda vai sair da conta".',
      action: { label: 'Ver a fatura', to: '/cartoes' },
    });
  }

  // 4. Fatura bem acima do padrão do cartão.
  run.n++;
  for (const i of outlook.invoices) {
    if (i.history_count < 2 || i.avg_variable_cents === null) continue;
    const usual = i.fixed_cents + i.avg_variable_cents;
    if (i.committed_cents > usual * OUTLIER_FACTOR && i.committed_cents - usual >= OUTLIER_MIN_CENTS) {
      raise({
        code: 'invoice_outlier',
        level: 'warn',
        title: `Fatura ${i.card_name} (vence ${dm(i.due_date)}) está bem acima do padrão`,
        detail: `Já lançado ${formatBRL(i.committed_cents)}; o padrão das últimas faturas é cerca de ${formatBRL(usual)}. Confira se há compra repetida ou um valor fora do comum.`,
        action: { label: 'Ver a fatura', to: '/cartoes' },
      });
    }
  }

  // 5. Estimativa apoiada em pouco histórico.
  run.n++;
  const thin = outlook.invoices.filter((i) => i.basis === 'estimate' && i.history_count === 1);
  if (thin.length) {
    raise({
      code: 'thin_history',
      level: 'info',
      title: `Estimativa com pouco histórico em ${thin.length} ${thin.length === 1 ? 'cartão' : 'cartões'}`,
      detail: `${thin.map((i) => i.card_name).join(', ')}: a média usa só 1 fatura fechada. Importe mais faturas antigas para a estimativa ficar mais firme.`,
      action: { label: 'Importar fatura', to: '/importar' },
    });
  }

  // 6. Faturas abertas desatualizadas.
  run.n++;
  const stale = outlook.invoices.filter((i) => i.is_stale);
  if (stale.length) {
    raise({
      code: 'stale_invoices',
      level: 'warn',
      title: `${stale.length} ${stale.length === 1 ? 'fatura aberta está desatualizada' : 'faturas abertas estão desatualizadas'}`,
      detail: `${stale.map((i) => i.card_name).join(', ')}: a última compra lançada (ou o valor parcial informado) tem mais de 3 dias. Reimporte a fatura aberta ou informe o valor parcial que o app do banco mostra hoje.`,
      action: { label: 'Atualizar faturas', to: '/cartoes' },
    });
  }

  // 7. Compras idênticas no mesmo dia (possível importação repetida).
  run.n++;
  if (input.duplicates.length) {
    const extra = input.duplicates.reduce((s, d) => s + d.total_cents * (d.count - 1), 0);
    raise({
      code: 'possible_duplicates',
      level: 'warn',
      title: `${input.duplicates.length} ${input.duplicates.length === 1 ? 'grupo de compras idênticas' : 'grupos de compras idênticas'} no mesmo dia`,
      detail: `Mesma data, valor e descrição no mesmo cartão. Se alguma for repetida, o custo está ${formatBRL(extra)} acima do real. Pode ser legítimo (duas compras iguais no dia).`,
      action: { label: 'Ver lançamentos', to: '/lancamentos' },
    });
  }

  // 8. Previsão de caixa × visão do mês (as duas contas devem fechar).
  run.n++;
  if (Math.abs(outlook.committed_cents - input.overview_pending_cents) > 1) {
    raise({
      code: 'outlook_mismatch',
      level: 'warn',
      title: 'A previsão de caixa e o "ainda vai sair da conta" não fecham',
      detail: `A previsão de caixa tem ${formatBRL(outlook.committed_cents)} já lançados e a visão do mês, ${formatBRL(input.overview_pending_cents)}. Confira faturas vencidas, pagamentos sem fatura e itens sem data.`,
    });
  }

  // 9. Mês sem receita lançada.
  run.n++;
  if (input.income_cents === 0 && input.scheduled_income_cents === 0) {
    raise({
      code: 'no_income',
      level: 'warn',
      title: 'Nenhuma receita lançada neste mês',
      detail: 'Sem o salário, a sobra prevista do mês aparece negativa. Cadastre o salário como recorrência em Configurações ou lance a receita.',
      action: { label: 'Abrir Configurações', to: '/configuracoes' },
    });
  }

  // 10. Despesas sem categoria.
  run.n++;
  if (input.uncategorized.count > 0) {
    raise({
      code: 'uncategorized',
      level: 'info',
      title: `${input.uncategorized.count} ${input.uncategorized.count === 1 ? 'despesa sem categoria' : 'despesas sem categoria'} (${formatBRL(input.uncategorized.total_cents)})`,
      detail: 'O total do mês não muda, mas o gasto por categoria e o orçamento ficam incompletos.',
      action: { label: 'Ver lançamentos', to: '/lancamentos' },
    });
  }

  // 11. Quanto do previsto é só estimativa (contexto para decidir quanto confiar).
  run.n++;
  const certainPct = outlook.estimated_cents > 0 ? Math.min(100, Math.round((outlook.committed_cents / outlook.estimated_cents) * 100)) : null;
  if (outlook.has_estimates && certainPct !== null && certainPct < 70) {
    raise({
      code: 'mostly_estimate',
      level: 'info',
      title: `Só ${certainPct}% da saída prevista de ${month.slice(5, 7)}/${month.slice(0, 4)} está lançada`,
      detail: `${formatBRL(outlook.committed_cents)} já lançados de ${formatBRL(outlook.estimated_cents)} esperados; o resto é estimativa pela média das faturas anteriores e muda quando as faturas fecharem.`,
    });
  }

  // 12. Saída prevista do mês contra o limite que o usuário definiu.
  run.n++;
  if (input.limit_cents != null && input.limit_cents > 0) {
    const limit = input.limit_cents;
    const label = `${month.slice(5, 7)}/${month.slice(0, 4)}`;
    const certain = outlook.paid_cents + outlook.committed_cents;
    const expected = outlook.paid_cents + outlook.estimated_cents;
    if (certain > limit) {
      raise({
        code: 'over_limit',
        level: 'bad',
        title: `A saída de ${label} já passa do seu limite`,
        detail: `Só com o que já está lançado ou pago são ${formatBRL(certain)}, ${formatBRL(certain - limit)} acima do limite de ${formatBRL(limit)}. Com as estimativas, o esperado é ${formatBRL(expected)}.`,
        action: { label: 'Ver faturas', to: '/cartoes' },
      });
    } else if (expected > limit) {
      raise({
        code: 'over_limit',
        level: 'warn',
        title: `A saída esperada de ${label} passa do seu limite`,
        detail: `Esperado ${formatBRL(expected)} (${formatBRL(certain)} já lançados ou pagos, o resto é estimativa) contra o limite de ${formatBRL(limit)}: ${formatBRL(expected - limit)} acima se a estimativa se confirmar.`,
        action: { label: 'Ver faturas', to: '/cartoes' },
      });
    }
  }

  const order: Record<CheckLevel, number> = { bad: 0, warn: 1, info: 2 };
  checks.sort((a, b) => order[a.level] - order[b.level]);
  const failed = new Set(checks.map((c) => c.code));
  const CODES = [
    'invoice_sum_mismatch', 'invoice_negative', 'invoice_overdue', 'invoice_outlier', 'thin_history', 'stale_invoices',
    'possible_duplicates', 'outlook_mismatch', 'no_income', 'uncategorized', 'mostly_estimate', 'over_limit',
  ];
  return {
    month,
    checks,
    total: run.n,
    passed: CODES.filter((c) => !failed.has(c)).length,
    certain_pct: certainPct,
  };
}
