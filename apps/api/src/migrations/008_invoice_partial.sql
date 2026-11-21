-- Valor parcial informado de uma fatura aberta (ex.: o total que aparece hoje no app do banco).
-- Serve para cartões cuja fatura só dá para baixar depois do fechamento: a previsão usa o maior entre as compras
-- lançadas e este valor. Não é o total confirmado (esse só vale com a fatura fechada).
-- Só colunas novas em tabela existente: o RLS da tabela já está ligado.
alter table invoices
  add column partial_total_cents bigint check (partial_total_cents >= 0),
  add column partial_on date,
  add constraint invoices_partial_check check ((partial_total_cents is null) = (partial_on is null));
