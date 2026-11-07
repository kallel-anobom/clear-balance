# AGENTS.md — Clear Balance

Guia para agentes de IA (Cursor, Claude Code, Codex etc.) que trabalham neste repositório. Leia inteiro antes de mexer em código. Detalhes de produto estão no `README.md`; aqui ficam as regras e armadilhas que não são óbvias pelo código.

Arquivos relacionados: `apps/api/AGENTS.md` (API) e `apps/web/AGENTS.md` (interface).

## O que é

Sistema de **finanças pessoais em português do Brasil** para uma única pessoa. Controla contas, cartões, faturas, parcelas, recorrências, orçamento e importação de extratos (CSV, PDF, imagem com OCR no navegador).

- Monorepo npm workspaces: `apps/api` (Fastify 5 + TypeScript, `pg`, `zod`, vitest) e `apps/web` (React 19 + Vite + react-query).
- Banco PostgreSQL. Hospedagem gratuita: **Vercel** (site e API como uma função em `api/index.mjs`) e **Supabase** (Postgres e Auth).
- Produção: `clear-balance-tau.vercel.app`. Repositório público no GitHub: `kallel-anobom/clear-balance`.
- Um único usuário (lista `ALLOWED_EMAILS`), 2FA opcional (`REQUIRE_MFA`).

## Comandos

```bash
npm run setup          # primeira instalação (instala, sobe o Postgres local, migra e carrega dados de exemplo)
npm run dev            # API + web em desenvolvimento
npm run typecheck      # tipos da API e da web
npm test               # vitest da API (inclui integração com Postgres real)
npm run build          # build de produção da API e da web
npm run db:up          # Postgres local (Docker, 127.0.0.1:5433)
npm run db:migrate     # aplica migrações pendentes
```

**Antes de entregar qualquer mudança, rode `npm run typecheck`, `npm test` e `npm run build`.** O CI roda os três (job "Typecheck, testes e build", obrigatório para mergear), mais varredura de segredos (gitleaks) e `npm audit`.

## Regras do domínio financeiro (não quebre)

- **Dinheiro sempre em centavos inteiros.** Nunca use ponto flutuante para valores. Formate só na borda (`brl` na web, `formatBRL` em `services/summary.ts`).
- **Custo do mês é por competência e pela "minha parte"**: compra no cartão conta na data da compra; despesa dividida usa `my_share_cents`.
- **Gasto ≠ saída de caixa.** O pagamento da fatura é saída de caixa e **nunca** soma como despesa. Transferências entre contas próprias, amortização de cheque especial, reembolsos e a parte dos outros ficam fora do custo (aparecem em "Não entra no custo").
- **Nada é inventado:** sem saldo informado não existe "saldo"; sem data, o item fica "data a confirmar". Valores estimados ficam marcados (`is_estimate`).
- `computeOverview` (`apps/api/src/services/overview.ts`) é uma **função pura**: não faz consulta ao banco. Os dados chegam por `services/overviewData.ts`. Mantenha assim para testar sem banco.
- Mês no formato `AAAA-MM` (`month_ref`). Datas `AAAA-MM-DD`.
- No driver `pg`, `int8` e `numeric` são convertidos para `Number` em `db.ts`.

## Privacidade e segurança (inegociável)

- **O repositório é público.** Nunca coloque dados reais (extratos, nomes, valores pessoais), chaves, senhas, URLs de banco ou tokens em código, testes, README, commits ou exemplos. Testes usam dados fictícios.
- **Não leia nem imprima valores do `.env`.** Se precisar saber se uma variável existe, pergunte ao usuário. Nunca peça segredos no chat; se o usuário colar um, avise para revogá-lo.
- `.env` está no `.gitignore`. A linha `MIGRATE_DATABASE_URL` fica **comentada** depois de usada (senão migra o banco de produção sem querer).
- `AUTH_DISABLED=true` é só para uso local; o servidor recusa subir em produção com isso.
- Logs não registram corpo de requisição nem conteúdo de extratos.
- **IA (Anthropic) é opcional e desligada por padrão**; a chave existe só no servidor.
  - Leitor de extratos: só o texto, antes passado por `importer/redact.ts` (CPF, e-mail, telefone, cartão, conta).
  - Resumo do mês: **só agregados** calculados no servidor (nunca descrições, datas, nomes de estabelecimentos, contas ou cartões). Todo número do texto da IA é conferido contra os dados enviados; se algum não existir, o texto é descartado.
  - Toda saída de IA é **proposta**: o usuário revisa antes de salvar. A IA nunca grava no banco.
  - Cada chamada conta no limite mensal (`AI_MONTHLY_LIMIT`), mesmo quando a resposta é descartada.
- CSP em `vercel.json`: o navegador só fala com o próprio site e com o Supabase (`connect-src`). Chamar outro domínio a partir da web exige mudar o CSP de propósito; prefira chamar pelo servidor.
- **Regras aprendidas** (`learned_rules`) guardam só o nome normalizado do estabelecimento (`merchantKey`: até 3 palavras, sem dígitos) e a classificação. Nunca valores, datas ou texto do extrato.

## Banco de dados e migrações

- Migrações em `apps/api/src/migrations/NNN_nome.sql`, numeradas em sequência, **nunca edite uma migração já aplicada** (crie a próxima).
- **Toda tabela nova ativa RLS** (`alter table ... enable row level security;`, sem políticas): a API acessa pelo servidor, o acesso direto pelo Supabase fica negado.
- Tabela nova com dados do usuário precisa entrar em **"Apagar todos os dados"** (`truncate` em `routes/data.ts`) e no `/data/summary`, com teste.
- **Produção:** a migração deve rodar **antes** de mergear código que depende dela. Duas formas:
  1. No computador: descomentar `MIGRATE_DATABASE_URL` no `.env` (URL do **Session pooler, porta 5432**), `npm run db:migrate`, comentar de novo. Se a variável estiver comentada, o comando migra o Docker local sem avisar: confira a saída.
  2. No GitHub: Actions > "Migrar banco (produção)" (manual, usa o secret `MIGRATE_DATABASE_URL` do ambiente `production`).
- O runtime em produção usa `DATABASE_URL` com o **pooler de transação (porta 6543)**.
- Quem roda migrações em produção é o **usuário**, não o agente.

## Fluxo de git e entrega

- `main` é protegida: só entra por **pull request**, com o check "Typecheck, testes e build" verde, em **squash merge**.
- Branches: `feat/...`, `fix/...`, `docs/...`. Commits semânticos em português (`feat(api): ...`, `fix(web): ...`), sem acentos nos prefixos curtos se preferir, mensagem curta.
- Mudanças grandes viram PRs pequenos e empilhados, mergeados em ordem. Depois de um squash, rebaseie o próximo PR (`git rebase --onto`) para evitar conflito.
- **O agente faz commits, mas não faz push.** O push pede passphrase de SSH e é feito pelo usuário. O `git fetch` por SSH também falha no ambiente do agente.
- Conflito de merge resolvido à mão já quebrou o build (um componente ficou duplicado): depois de resolver, sempre rode typecheck, testes e build.
- Antes de dizer que terminou: informe ao usuário o que ele precisa fazer (migração, variável de ambiente na Vercel, merge, ordem dos PRs).

## Testes

- `apps/api/test`: unitários (vitest) e `api.integration.test.ts`, que cria o banco `clearbalance_test` no Postgres local e testa a API de ponta a ponta. Sem Postgres, os testes de integração são pulados; no CI (`REQUIRE_DB_TESTS=1`) eles falham se o banco não existir.
- O teste de integração define `AUTH_DISABLED='true'` sozinho (não depende do `.env`).
- **Testes nunca chamam a rede.** A IA é simulada com `vi.stubGlobal('fetch', ...)` e `config.anthropicApiKey` é alterado em memória.
- Dados de teste em meses isolados (ex.: `2031-05`) para não colidir com outros blocos do mesmo arquivo. Os blocos rodam em ordem e compartilham o banco; no fim há o teste de "apagar tudo".
- Não há testes de interface (web). Mudança visual é conferida à mão: diga ao usuário o que olhar.

## Convenções

- **Textos da interface, mensagens de erro e documentação em português do Brasil**, tom simples e direto. Código e nomes de variáveis em inglês, comentários em português explicando o *porquê*.
- TypeScript estrito, `zod` para validar entrada, sem `any` solto.
- Prefira mudar o que existe a criar arquivos novos. Não crie documentação além do que for pedido; atualize o `README.md` quando mudar comportamento visível.
- Não adicione dependências sem necessidade (o projeto roda em plano gratuito e o `npm audit` é checado no CI).

## Armadilhas conhecidas

- No macOS, `sed -i` (BSD) se comporta diferente do GNU: para editar arquivos prefira as ferramentas de edição ou `python3`.
- `merchantKey` descarta palavras de uma letra e ruídos de PIX/TED (`pix`, `enviado`...). Nomes como "Clube Z" viram só "clube".
- A função da Vercel tem `maxDuration` de 30 s (`vercel.json`). A chamada à IA tem timeout de 25 s **por trecho**; extratos grandes são divididos em trechos paralelos (`splitForAi`). Não aumente o timeout acima do limite da função.
- "Apagar importação" apaga **todos** os lançamentos daquele lote, inclusive os editados à mão. Avise o usuário antes de sugerir reimportar.
- Importar de novo sem apagar marca as linhas como duplicadas (impressão digital) e as pula.
- Prioridade da categoria sugerida: regra exata > histórico idêntico > nome parecido > palavras-chave > categoria da IA.

## Estado atual (nov/2026)

Entregue: custo do mês por competência, importação (CSV, PDF, imagem), parcelas projetadas, recorrências, regras aprendidas com similaridade, aprender ao editar em Lançamentos, orçamento fixo por categoria, comparação com a média dos 3 meses anteriores, assinaturas detectadas, leitor de reserva com IA (em trechos paralelos) e resumo do mês com IA.

Ideias em aberto (só fazer se o usuário pedir): alertas de orçamento, metas de economia, orçamento por mês, exportar CSV, backup automático, testes de interface.
