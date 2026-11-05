-- Segurança para uso com Supabase.
-- O Supabase expõe as tabelas do schema "public" pela Data API (REST) usando a chave "anon" do navegador.
-- Ligamos RLS em TODAS as tabelas e não criamos nenhuma policy: com isso, a chave anon (e qualquer
-- usuário autenticado pela Data API) não lê nem grava nada. Somente a nossa API, que conecta
-- diretamente ao banco com a connection string do servidor, acessa os dados.
do $$
declare
  t record;
begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;

  -- Remove também os privilégios padrão dos papéis da Data API (só existem no Supabase).
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
    execute 'revoke all on all sequences in schema public from anon';
    execute 'revoke all on all functions in schema public from anon';
    execute 'alter default privileges in schema public revoke all on tables from anon';
    execute 'alter default privileges in schema public revoke all on sequences from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on all tables in schema public from authenticated';
    execute 'revoke all on all sequences in schema public from authenticated';
    execute 'revoke all on all functions in schema public from authenticated';
    execute 'alter default privileges in schema public revoke all on tables from authenticated';
    execute 'alter default privileges in schema public revoke all on sequences from authenticated';
  end if;
end $$;
