import pg from 'pg';
import { config } from './config.js';

// BIGINT (valores em centavos) e NUMERIC chegam como string por padrão; converte para number.
// Valores em centavos ficam muito abaixo de Number.MAX_SAFE_INTEGER.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC (resultado de sum() sobre bigint) também vira number.
pg.types.setTypeParser(1700, (v) => Number(v));
// DATE vira string 'YYYY-MM-DD' (sem fuso horário).
pg.types.setTypeParser(1082, (v) => v);

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === 'db';
  } catch {
    return true;
  }
}

/**
 * Cria um pool de conexões. Em bancos remotos (Supabase) a conexão é sempre criptografada (TLS).
 * O Supabase usa uma CA própria: informe DATABASE_SSL_CA (PEM) para validar o certificado;
 * sem ela a conexão é criptografada, mas o certificado do servidor não é verificado.
 */
export function createPool(url: string, opts: { max?: number } = {}): pg.Pool {
  const remote = !isLocalHost(url);
  let connectionString = url;
  if (remote) {
    // O TLS é configurado abaixo; evita que "sslmode" na URL conflite com isso.
    try {
      const u = new URL(url);
      u.searchParams.delete('sslmode');
      connectionString = u.toString();
    } catch {
      /* mantém a URL */
    }
  }
  const ca = process.env.DATABASE_SSL_CA?.replace(/\\n/g, '\n');
  return new pg.Pool({
    connectionString,
    // Serverless: cada instância mantém poucas conexões; o pooler do Supabase (porta 6543) multiplexa.
    max: opts.max ?? (config.isServerless ? 1 : 8),
    idleTimeoutMillis: config.isServerless ? 10_000 : 30_000,
    ssl: remote ? (ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: false }) : undefined,
  });
}

export const pool = createPool(config.databaseUrl);

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

export async function withTx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
