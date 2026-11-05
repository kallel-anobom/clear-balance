-- Importações a partir de imagem (OCR feito no navegador).
alter table import_batches drop constraint if exists import_batches_source_kind_check;
alter table import_batches add constraint import_batches_source_kind_check
  check (source_kind in ('csv', 'pdf', 'image'));

-- Parcelamentos de cartão ("PARC 02/10").
--  installment_no / installment_total: parcela atual e total.
--  installment_group: identifica a mesma compra parcelada (cartão + descrição base + valor da parcela).
--  is_projected: parcela futura criada pelo sistema a partir de uma parcela real; ainda não apareceu em fatura.
alter table transactions
  add column installment_no integer,
  add column installment_total integer,
  add column installment_group text,
  add column is_projected boolean not null default false,
  add constraint transactions_installment_check check (
    (installment_no is null and installment_total is null)
    or (installment_no >= 1 and installment_total >= installment_no and installment_total <= 120)
  );

create index transactions_installment_group_idx on transactions (installment_group) where installment_group is not null;
-- Uma parcela de cada compra por vez (evita projetar duas vezes a mesma parcela).
create unique index transactions_installment_unique
  on transactions (installment_group, installment_no) where installment_group is not null;
