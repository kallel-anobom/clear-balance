-- Valores monetários sempre em CENTAVOS (bigint). Datas sem fuso (date).
-- Privacidade: não existem colunas para senha, token, CVV nem número completo de cartão.

create table accounts (
  id serial primary key,
  name text not null,
  kind text not null default 'checking' check (kind in ('checking', 'savings', 'cash', 'investment')),
  -- Saldo informado por mim. NULL = não informado (o sistema nunca inventa saldo).
  -- Negativo = saldo devedor (cheque especial em uso).
  balance_cents bigint,
  balance_date date,
  overdraft_limit_cents bigint,
  created_at timestamptz not null default now()
);

create table cards (
  id serial primary key,
  name text not null,
  last4 char(4) check (last4 ~ '^[0-9]{4}$'),           -- apenas os 4 últimos dígitos
  closing_day smallint not null check (closing_day between 1 and 31),
  due_day smallint not null check (due_day between 1 and 31),
  default_account_id int references accounts(id) on delete set null,
  created_at timestamptz not null default now()
);

create table categories (
  id serial primary key,
  slug text not null unique,
  name text not null unique,
  kind text not null default 'expense' check (kind in ('expense', 'income'))
);

create table import_batches (
  id serial primary key,
  label text not null,
  source_kind text not null check (source_kind in ('csv', 'pdf')),
  row_count int not null default 0,
  created_at timestamptz not null default now()
);

create table invoices (
  id serial primary key,
  card_id int not null references cards(id) on delete cascade,
  closing_date date,
  due_date date not null,                -- vencimento da fatura
  statement_total_cents bigint,          -- total informado/confirmado na fatura (NULL = ainda não confirmado)
  paid_on date,                          -- data do pagamento (NULL = não paga)
  created_at timestamptz not null default now(),
  unique (card_id, due_date)
);

create table recurring_items (
  id serial primary key,
  description text not null,
  type text not null check (type in ('expense', 'income')),
  category_id int references categories(id) on delete set null,
  account_id int references accounts(id) on delete set null,
  frequency text not null default 'monthly' check (frequency in ('monthly', 'yearly')),
  day_of_month smallint check (day_of_month between 1 and 31),   -- NULL = dia não definido
  month_of_year smallint check (month_of_year between 1 and 12), -- só para anuais; NULL = mês não definido
  start_month char(7) check (start_month ~ '^\d{4}-\d{2}$'),
  end_month char(7) check (end_month ~ '^\d{4}-\d{2}$'),
  total_cents bigint not null,           -- despesa: total pago pela conta | receita: líquido
  my_share_cents bigint,                 -- despesa: minha parte
  gross_cents bigint,                    -- receita: bruto
  deductions_cents bigint,               -- receita: impostos/descontos
  shared_with text,
  is_estimate boolean not null default false,
  needs_review boolean not null default false,
  review_note text,
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table transactions (
  id serial primary key,
  type text not null check (type in ('income', 'expense', 'transfer', 'reimbursement', 'invoice_payment', 'overdraft_payment')),
  description text not null,
  category_id int references categories(id) on delete set null,
  account_id int references accounts(id) on delete set null,        -- conta que paga/recebe (origem, em transferências)
  transfer_account_id int references accounts(id) on delete set null, -- destino da transferência
  card_id int references cards(id) on delete set null,
  invoice_id int references invoices(id) on delete set null,        -- compra: fatura em que entra | pagamento: fatura paga
  status text not null default 'paid' check (status in ('paid', 'scheduled')),
  month_ref char(7) not null check (month_ref ~ '^\d{4}-\d{2}$'),   -- mês de competência (onde o gasto é contado)
  occurred_on date,                      -- data da compra / do evento
  due_date date,                         -- vencimento (contas) ou data prevista (receitas)
  paid_on date,                          -- data do pagamento/recebimento (saída/entrada de caixa)
  date_confirmed boolean not null default true,
  total_cents bigint not null,           -- valor total que passa pela conta (receita: líquido; estorno: negativo)
  my_share_cents bigint,                 -- despesa: minha parte (custo pessoal)
  gross_cents bigint,                    -- receita: bruto
  deductions_cents bigint,               -- receita: impostos/descontos
  shared_with text,
  reimbursement_for_id int references transactions(id) on delete set null,
  is_estimate boolean not null default false,
  needs_review boolean not null default false,
  review_note text,
  notes text,
  recurring_id int references recurring_items(id) on delete set null,
  import_batch_id int references import_batches(id) on delete cascade,
  import_hash text,                      -- impressão digital (hash) para detectar duplicatas; não contém texto do extrato
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index transactions_recurring_month_uq on transactions (recurring_id, month_ref) where recurring_id is not null;
create index transactions_month_idx on transactions (month_ref);
create index transactions_paid_idx on transactions (paid_on);
create index transactions_due_idx on transactions (due_date);
create index transactions_hash_idx on transactions (import_hash) where import_hash is not null;
create index transactions_invoice_idx on transactions (invoice_id);

-- Recorrências removidas manualmente em um mês, para não serem recriadas.
create table recurring_skips (
  recurring_id int not null references recurring_items(id) on delete cascade,
  month_ref char(7) not null,
  primary key (recurring_id, month_ref)
);

create table settings (
  key text primary key,
  value jsonb not null
);
