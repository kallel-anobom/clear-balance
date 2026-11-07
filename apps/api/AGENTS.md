# AGENTS.md — apps/api

Leia primeiro o `AGENTS.md` da raiz (regras de domínio, privacidade, migrações e git). Aqui ficam só os detalhes da API.

## Estrutura

```
src/server.ts        monta o Fastify; rotas ficam sob /api (registre a rota nova aqui)
src/config.ts        variáveis de ambiente (lê o .env da raiz); nada de process.env espalhado
src/db.ts            pool, withTx (transação), tipos numéricos convertidos para Number
src/auth.ts          valida o JWT do Supabase e a lista ALLOWED_EMAILS (+ REQUIRE_MFA)
src/errors.ts        HttpError, badRequest, notFound: use estes, com mensagem em português
src/lib.ts           datas (AAAA-MM, addMonths, monthBounds), parseMoney, normalizeText
src/migrations/      NNN_nome.sql (copiadas para dist no build)
src/routes/          uma rota por assunto, fina: valida (zod), chama services, responde
src/services/        regras de negócio; overview.ts é função pura
src/importer/        leitura de CSV/PDF, classificação, parcelas, IA (anthropic.ts, llm.ts, redact.ts)
test/                vitest (unitário + api.integration.test.ts com Postgres real)
```

## Como adicionar uma rota

1. Crie `routes/nome.ts` exportando `async function nomeRoutes(app: FastifyInstance)` e registre em `server.ts`.
2. Valide `body`/`query` com `zod`. Erros de usuário viram `badRequest('mensagem em português')`; não encontrado, `notFound()`.
3. Regra de negócio fica em `services/`, não na rota. Se for cálculo, prefira função pura e teste unitário.
4. Se mexer em dados que entram no "Apagar todos os dados" ou no `/data/summary`, atualize `routes/data.ts`.
5. Teste: unitário para a regra e um caso em `api.integration.test.ts` para a rota (status 200 e os casos de erro).

## Banco

- Consultas parametrizadas (`$1`, `$2`), nunca concatene valores em SQL. Nome de tabela dinâmico só a partir de lista fixa no código.
- Use `withTx` quando houver mais de uma escrita que precise ser atômica.
- Valores monetários: colunas `*_cents` (bigint) e `Number` no código.
- Tabela nova: migração com RLS ligado (veja o `AGENTS.md` da raiz).

## Overview, comparação e resumo

- `services/overviewData.ts`: `buildOverview(month)` busca os dados e chama `computeOverview`; `loadComparison(month)` compara com a média dos até 3 meses anteriores **que têm gastos**.
- `services/compare.ts`, `services/subscriptions.ts` e `services/summary.ts` são funções puras (menos `writeSummary`, que chama a IA) com testes em `test/budget.test.ts` e `test/summary.test.ts`.
- Orçamento: `budgetStatus` = `ok` até 80%, `near` de 80% a 100%, `over` acima de 100%.
- Assinaturas: mesmo `merchantKey`, valor até 15% da mediana, 3+ meses seguidos e ainda ativa; ignora parcelas, previstos, itens de recorrência e quem já tem recorrência.

## IA

- `importer/anthropic.ts` é a única porta para a API da Anthropic (`callAnthropicTool`, uso forçado de ferramenta, `AiError` com mensagem e status). Não chame `fetch` da Anthropic em outro lugar.
- Mensagens de erro e logs **nunca** incluem o texto do usuário nem o corpo da resposta.
- Valide a saída da IA com `zod` e confira contra os dados de entrada (valores existem no texto; números do resumo existem nos fatos). Na dúvida, descarte.
- Antes de qualquer chamada: IA ligada (`getAiState`), chave presente e limite mensal; depois, `countAiCall`.
- Para testar, simule `fetch`. Nunca use a chave real em teste.

## Checklist antes de entregar

- [ ] `npm run typecheck -w apps/api` sem erros
- [ ] `npm test -w apps/api` verde (rode a suíte inteira, o arquivo de integração é compartilhado)
- [ ] Nenhum dado real ou segredo nos arquivos, testes ou mensagens de commit
- [ ] Migração nova? Avise o usuário para rodar em produção **antes** do merge
