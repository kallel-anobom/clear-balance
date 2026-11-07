import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Carrega o .env da raiz do projeto (se existir) sem depender de bibliotecas extras.
function loadDotEnv() {
  const candidates = [resolve(process.cwd(), '.env'), resolve(process.cwd(), '../../.env')];
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    return;
  }
}
loadDotEnv();

const isProduction = process.env.NODE_ENV === 'production';
const isServerless = Boolean(process.env.VERCEL);

export const config = {
  isProduction,
  isServerless,
  databaseUrl:
    process.env.DATABASE_URL ?? 'postgres://clearbalance:clearbalance_local@127.0.0.1:5433/clearbalance',
  // Conexão direta/session do Supabase, usada só para rodar migrações do seu computador.
  migrateDatabaseUrl: process.env.MIGRATE_DATABASE_URL,
  port: Number(process.env.API_PORT ?? 3001),
  // Limite do arquivo importado (15 MB) — extratos e faturas são pequenos.
  maxUploadBytes: 15 * 1024 * 1024,
  // IA opcional (Anthropic). Sem a chave, o recurso fica indisponível. A chave existe só no servidor.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || undefined,
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5',
  // Teto de chamadas por mês (controle local; defina também um limite de gasto no console da Anthropic).
  aiMonthlyLimit: Number(process.env.AI_MONTHLY_LIMIT ?? 60),
  // Tempo máximo da chamada; precisa ficar abaixo do maxDuration (30 s) da função na Vercel.
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS ?? 25000),
};
