# AGENTS.md — apps/web

Leia primeiro o `AGENTS.md` da raiz. Aqui ficam só os detalhes da interface.

## Estrutura

```
src/main.tsx, App.tsx   entrada, rotas (react-router) e layout
src/pages/              Overview (Visão do mês), Transactions, Cards, Import, Settings
src/api.ts              cliente HTTP (api.get/post/put/patch/del/upload) e os TIPOS das respostas da API
src/hooks.ts            useMonth (mês na URL ?mes=AAAA-MM), useLookups, useRefresh
src/components.tsx      Panel, Badge, Field, MoneyField, Modal, Empty, Loading, ErrorBox
src/format.ts           brl, dateBR, monthLabel, addMonths, parseMoneyInput
src/Insights.tsx        comparação, assinaturas e resumo do mês com IA
src/Budgets.tsx         painel de orçamento por categoria
src/TxForm.tsx          formulário de lançamento (inclui "lembrar para este estabelecimento")
src/ocr.ts              leitura de PDF/imagem no navegador (pdfjs e Tesseract); nada vai para o servidor além do texto
src/auth.tsx, supabase.ts, Security.tsx   login e 2FA
```

## Convenções

- **Interface, mensagens e rótulos em português do Brasil.** Tom simples, sem jargão. Valores sempre com `brl()`, datas com `dateBR()`, meses com `monthLabel()`.
- Dados do servidor com `useQuery` (react-query); escrita com `useMutation`. Depois de qualquer alteração chame `useRefresh()` (invalida tudo).
- **Os tipos em `api.ts` espelham a resposta da API.** Mudou a API? Atualize o tipo na mesma entrega, senão o `tsc` do build quebra.
- Valores em centavos na tela também: `MoneyField` recebe e devolve centavos.
- Estilos em `src/styles.css` (classes simples como `.panel`, `.row`, `.badge`, `.bar`); reutilize antes de criar classe nova. Cores: `var(--good)`, `var(--bad)`, `.neg` para negativo.
- Mostre estado de carregamento (`Loading`), vazio (`Empty`) e erro (`ErrorBox`) em toda consulta.
- Ações destrutivas pedem `confirm(...)` com o que será afetado. Ações em lote mostram prévia antes (veja "Aplicar aos antigos" em Configurações).
- Acessibilidade básica: `aria-label` em controles sem texto, barras de progresso com `role="progressbar"`.

## Restrições

- O CSP (`vercel.json`) só permite falar com o próprio site e o Supabase. Não adicione chamadas a outros domínios, CDNs ou fontes externas sem decidir isso com o usuário. Os arquivos do OCR são copiados para `public/ocr/` no build (não vão para o git).
- Nenhum segredo no front-end. Só `VITE_SUPABASE_URL` e `VITE_SUPABASE_ANON_KEY` (públicas por natureza).
- Não há testes de interface. Como `tsc` e `build` passam mesmo com tela estranha, **descreva ao usuário o que conferir no navegador** (qual tela, qual comportamento esperado).

## Checklist antes de entregar

- [ ] `npm run typecheck -w apps/web` sem erros e `npm run build` ok
- [ ] Tipos de `api.ts` batem com a API
- [ ] Textos em português, valores com `brl()`
- [ ] Estados de carregamento, vazio e erro tratados
- [ ] Usuário avisado do que olhar na tela
