import { config } from '../config.js';
import type { Queryable } from '../db.js';

/** Estado da IA opcional: interruptor e contador mensal ficam em `settings` (chave/valor), sem tabela nova. */
export interface AiState {
  enabled: boolean;
  available: boolean;
  month: string;
  calls: number;
  limit: number;
  model: string;
}

const currentMonth = () => new Date().toISOString().slice(0, 7);

export async function getAiState(db: Queryable): Promise<AiState> {
  const { rows } = await db.query(`select key, value from settings where key in ('ai_enabled', 'ai_usage')`);
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const month = currentMonth();
  const usage = s.ai_usage as { month?: string; calls?: number } | undefined;
  return {
    enabled: s.ai_enabled === true,
    available: Boolean(config.anthropicApiKey),
    month,
    calls: usage?.month === month ? (usage.calls ?? 0) : 0,
    limit: config.aiMonthlyLimit,
    model: config.anthropicModel,
  };
}

export async function setAiEnabled(db: Queryable, enabled: boolean) {
  await db.query(
    `insert into settings (key, value) values ('ai_enabled', $1) on conflict (key) do update set value = excluded.value`,
    [JSON.stringify(enabled)],
  );
}

/** Conta a chamada (a Anthropic cobra mesmo quando a resposta é recusada pela validação). */
export async function countAiCall(db: Queryable, state: AiState) {
  await db.query(
    `insert into settings (key, value) values ('ai_usage', $1) on conflict (key) do update set value = excluded.value`,
    [JSON.stringify({ month: state.month, calls: state.calls + 1 })],
  );
}
