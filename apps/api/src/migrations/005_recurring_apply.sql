-- Marca lançamentos gerados por recorrência que o usuário alterou à mão.
-- Ao propagar uma mudança da recorrência para meses futuros, esses lançamentos NÃO são sobrescritos.
alter table transactions add column manually_edited boolean not null default false;
