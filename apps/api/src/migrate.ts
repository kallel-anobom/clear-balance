import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';
import { config } from './config.js';
import { createPool, pool } from './db.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export async function migrate(target: pg.Pool = pool) {
  await target.query(`create table if not exists schema_migrations (
    name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await target.query('select name from schema_migrations')).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const client = await target.connect();
    try {
      await client.query('begin');
      await client.query(readFileSync(join(dir, file), 'utf8'));
      await client.query('insert into schema_migrations(name) values ($1)', [file]);
      await client.query('commit');
      console.log(`Migração aplicada: ${file}`);
    } catch (err) {
      await client.query('rollback');
      throw err;
    } finally {
      client.release();
    }
  }
  // Garante RLS também na tabela de controle de migrações (criada fora dos arquivos .sql).
  await target.query('alter table schema_migrations enable row level security');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // No Supabase, use a conexão direta/session (MIGRATE_DATABASE_URL), não o pooler de transações.
  const target = config.migrateDatabaseUrl ? createPool(config.migrateDatabaseUrl, { max: 1 }) : pool;
  migrate(target)
    .then(() => console.log('Banco atualizado.'))
    .catch((e) => {
      console.error('Falha na migração:', e.message);
      process.exitCode = 1;
    })
    .finally(() => target.end());
}
