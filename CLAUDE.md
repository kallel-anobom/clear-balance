# CLAUDE.md

As instruções para agentes deste projeto ficam em [`AGENTS.md`](./AGENTS.md) (raiz), com detalhes em [`apps/api/AGENTS.md`](./apps/api/AGENTS.md) e [`apps/web/AGENTS.md`](./apps/web/AGENTS.md). Leia-os antes de começar.

Resumo do essencial:

- Dinheiro em centavos inteiros; custo do mês por competência e pela "minha parte"; pagamento de fatura nunca soma como despesa.
- Repositório público: nenhum dado real ou segredo em arquivos. Não leia nem imprima valores do `.env`.
- Antes de entregar: `npm run typecheck`, `npm test` e `npm run build`.
- Migrações rodam em produção antes do merge e quem roda é o usuário. O usuário também faz o push.
- Interface e mensagens em português do Brasil.
