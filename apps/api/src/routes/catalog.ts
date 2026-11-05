import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../db.js';
import { notFound } from '../errors.js';

const cents = z.number().int().nullable().optional();

const accountSchema = z.object({
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['checking', 'savings', 'cash', 'investment']).default('checking'),
  balance_cents: cents,
  balance_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  overdraft_limit_cents: cents,
});

const cardSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // Somente os 4 últimos dígitos. Nunca o número completo.
  last4: z.string().regex(/^\d{4}$/, 'Informe somente os 4 últimos dígitos.').nullable().optional(),
  closing_day: z.number().int().min(1).max(31),
  due_day: z.number().int().min(1).max(31),
  default_account_id: z.number().int().positive().nullable().optional(),
});

const categorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  kind: z.enum(['expense', 'income']).default('expense'),
});

export async function catalogRoutes(app: FastifyInstance) {
  // ----- Contas -----
  app.get('/accounts', async () => (await pool.query('select * from accounts order by name')).rows);
  app.post('/accounts', async (req, reply) => {
    const b = accountSchema.parse(req.body);
    const { rows } = await pool.query(
      `insert into accounts (name, kind, balance_cents, balance_date, overdraft_limit_cents)
       values ($1,$2,$3,$4,$5) returning *`,
      [b.name, b.kind, b.balance_cents ?? null, b.balance_date ?? null, b.overdraft_limit_cents ?? null],
    );
    reply.code(201);
    return rows[0];
  });
  app.put<{ Params: { id: string } }>('/accounts/:id', async (req) => {
    const b = accountSchema.parse(req.body);
    const { rows } = await pool.query(
      `update accounts set name=$2, kind=$3, balance_cents=$4, balance_date=$5, overdraft_limit_cents=$6
       where id=$1 returning *`,
      [req.params.id, b.name, b.kind, b.balance_cents ?? null, b.balance_date ?? null, b.overdraft_limit_cents ?? null],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  });
  app.delete<{ Params: { id: string } }>('/accounts/:id', async (req, reply) => {
    await pool.query('delete from accounts where id = $1', [req.params.id]);
    reply.code(204);
  });

  // ----- Cartões -----
  app.get('/cards', async () => (await pool.query('select * from cards order by name')).rows);
  app.post('/cards', async (req, reply) => {
    const b = cardSchema.parse(req.body);
    const { rows } = await pool.query(
      `insert into cards (name, last4, closing_day, due_day, default_account_id) values ($1,$2,$3,$4,$5) returning *`,
      [b.name, b.last4 ?? null, b.closing_day, b.due_day, b.default_account_id ?? null],
    );
    reply.code(201);
    return rows[0];
  });
  app.put<{ Params: { id: string } }>('/cards/:id', async (req) => {
    const b = cardSchema.parse(req.body);
    const { rows } = await pool.query(
      `update cards set name=$2, last4=$3, closing_day=$4, due_day=$5, default_account_id=$6 where id=$1 returning *`,
      [req.params.id, b.name, b.last4 ?? null, b.closing_day, b.due_day, b.default_account_id ?? null],
    );
    if (!rows[0]) throw notFound();
    return rows[0];
  });
  app.delete<{ Params: { id: string } }>('/cards/:id', async (req, reply) => {
    await pool.query('delete from cards where id = $1', [req.params.id]);
    reply.code(204);
  });

  // ----- Categorias -----
  app.get('/categories', async () => (await pool.query('select * from categories order by kind desc, name')).rows);
  app.post('/categories', async (req, reply) => {
    const b = categorySchema.parse(req.body);
    const slug = b.name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const { rows } = await pool.query(
      `insert into categories (slug, name, kind) values ($1,$2,$3) returning *`,
      [`${slug}-${Date.now().toString(36)}`, b.name, b.kind],
    );
    reply.code(201);
    return rows[0];
  });

  // ----- Configurações -----
  app.get('/settings', async () => {
    const { rows } = await pool.query('select key, value from settings');
    const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    return { own_transfer_names: s.own_transfer_names ?? [] };
  });
  app.put('/settings', async (req) => {
    const b = z.object({ own_transfer_names: z.array(z.string().trim().min(2).max(80)).max(20) }).parse(req.body);
    await pool.query(
      `insert into settings (key, value) values ('own_transfer_names', $1)
       on conflict (key) do update set value = excluded.value`,
      [JSON.stringify(b.own_transfer_names)],
    );
    return b;
  });
}
