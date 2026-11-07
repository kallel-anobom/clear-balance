-- Orçamento por categoria: um teto mensal fixo, válido para todos os meses.
-- Mesma política das demais tabelas: RLS ligado e nenhuma policy (a Data API do Supabase não enxerga nada).
create table budgets (
  category_id int primary key references categories(id) on delete cascade,
  limit_cents bigint not null check (limit_cents > 0),
  updated_at timestamptz not null default now()
);

alter table budgets enable row level security;
