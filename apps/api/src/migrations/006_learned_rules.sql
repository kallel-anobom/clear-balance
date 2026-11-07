-- Regras aprendidas: o sistema lembra como você classificou um estabelecimento e repete na próxima importação.
-- Guardamos SOMENTE o nome normalizado do estabelecimento (sem números, datas ou valores) e a classificação escolhida.
-- Nada sai da sua base: não há envio para serviços externos.
create table learned_rules (
  id serial primary key,
  kind text not null check (kind in ('account', 'card')),
  pattern text not null check (length(pattern) between 3 and 60),
  category_id int references categories(id) on delete set null,
  type text check (type in ('income', 'expense', 'transfer', 'reimbursement', 'invoice_payment', 'overdraft_payment')),
  ignore boolean not null default false,
  use_count int not null default 1,
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (kind, pattern)
);

-- Mesma política das demais tabelas: RLS ligado e nenhuma policy (a Data API do Supabase não enxerga nada).
alter table learned_rules enable row level security;
