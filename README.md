# Clear Balance — controle financeiro pessoal (MVP)

Sistema em português do Brasil, que roda **local** (Docker) ou **hospedado de graça** (Vercel + Supabase, com login), para entender:

- quanto você gastou no mês;
- quanto ainda vai sair da conta e em quais datas;
- quanto deve sobrar depois dos salários e pagamentos;
- quais valores são seus e quais serão reembolsados por outras pessoas.

**Stack:** React + TypeScript (Vite) · Node.js + TypeScript (Fastify, como função da Vercel) · PostgreSQL 16 (Docker local ou Supabase) · Supabase Auth (login).
Funciona no computador e no celular (layout responsivo com barra inferior).

## Como iniciar

Pré-requisitos: **Node.js 20+** e **Docker** (só para o PostgreSQL).

```bash
npm run setup     # instala dependências, sobe o PostgreSQL, cria as tabelas e carrega os dados iniciais
npm run dev       # inicia a API (porta 3001) e a interface (porta 5173)
```

Abra **http://localhost:5173**. Nas próximas vezes basta:

```bash
npm run db:up     # se o Docker/banco não estiver no ar
npm run dev
```

> As portas 5433 (banco), 3001 (API) e 5173 (interface) podem ser mudadas em `.env` / `docker-compose.yml`.

> No uso local o login fica **desligado** (`AUTH_DISABLED=true` no `.env`, só aceito fora de produção). Hospedado, o login é obrigatório — veja [Hospedar de graça](#hospedar-de-graça-vercel--supabase).

### Usar no celular (modo local)

Em modo local não há login. Para abrir no celular, na mesma rede Wi-Fi:

```bash
npm run dev:lan   # no lugar de `npm run dev`; a interface mostra o endereço http://IP-DO-PC:5173
```

Só faça isso em uma rede de confiança (sem login, qualquer pessoa na rede veria seus dados). A API continua escutando apenas em `127.0.0.1`; o celular fala com ela pelo proxy da interface.

## Telas

| Tela | O que mostra |
| --- | --- |
| **Visão do mês** | **Custo total do mês** (minha parte, com o detalhamento de como chegamos nele), gasto já realizado × ainda previsto, quanto ainda vai sair e quando, salários (bruto, descontos, líquido), saldo/sobra prevista, reembolsos a receber, cheque especial, gasto por categoria e **pendências**. |
| **Lançamentos** | Receitas, despesas, transferências, reembolsos, pagamentos de fatura e do cheque especial. Filtros por mês, categoria, conta, cartão, tipo, situação e “só para revisar”. Edição de categoria/descrição, marcar para revisar, marcar como pago/recebido, registrar reembolso. |
| **Cartões e faturas** | Cartões, faturas (fechamento, vencimento e pagamento — três datas separadas), compras de cada fatura, total confirmado × estimado, conferência da soma, pagar fatura, vincular pagamentos soltos e **parcelas futuras** (quanto ainda cai em cada mês). |
| **Importação** | CSV, PDF e **imagens de extratos** (OCR no navegador) com **revisão antes de salvar**, detecção de duplicatas e de parcelas, vínculo a itens já previstos e apagar importações. |
| **Configurações** | Conta e segurança (2FA), contas e saldos (informados por você), recorrências/dados iniciais, nomes de transferências próprias, **regras aprendidas**, privacidade, backup e apagar dados. |

## Regras financeiras implementadas

- **Custo total do mês** (número principal da *Visão do mês*): tudo o que o mês custa **por competência**, na **minha parte**: compras no cartão pela data da compra + contas pagas + contas ainda previstas (incluindo parcelas e itens estimados, sinalizados). Ao abrir *Como chegamos no custo do mês* você vê o total por origem (parcelas, compras no cartão, recorrentes, outras contas) e, separado, o que **não entra** para não contar duas vezes: pagamento de fatura, transferências entre minhas contas, amortização do cheque especial, a parte dos outros em despesas divididas e reembolsos. Já o card *Ainda vai sair da conta (caixa)* mostra o que falta pagar, que é outra pergunta.
- **Gasto ≠ saída de caixa.** Compra no cartão é gasto na **data da compra**. O pagamento da fatura é **saída de caixa** na **data do pagamento** e nunca é somado como despesa (não há contagem dupla).
- **Transferências entre minhas contas** (ex.: PIX para “Fulano de Tal”) não são despesa nem receita. Os nomes que identificam transferências próprias ficam em *Configurações*.
- **Despesa compartilhada:** guarda o valor total, **minha parte** (meu custo pessoal), a parte dos outros e os reembolsos. A visão mostra seu gasto pela *minha parte* e a saída de caixa pelo *total pago*. Reembolso recebido é entrada de caixa (não é receita) e não altera o seu gasto.
- **Salário:** bruto, impostos/descontos e líquido (calculado) ficam separados. O líquido é marcado como **estimado** até você confirmar o valor real (ao marcar como recebido).
- **Cheque especial:** saldo negativo informado na conta = **saldo devedor**. Juros e tarifas são **despesa** (categoria “Juros e tarifas”). Pagar a dívida **não** é despesa e não relança o aluguel/fatura que originaram o saldo negativo.
  *Observação:* registre “Pagamento do cheque especial” apenas se o extrato o mostrar como um lançamento; quando o salário simplesmente cobre o saldo negativo, o saldo informado já reflete isso.
- **Datas separadas:** data da compra, vencimento (da conta/fatura) e data do pagamento são campos distintos. Itens sem data aparecem como **“data a confirmar”**.
- **Nada é inventado:** não há saldos, contas, cartões, datas de pagamento nem pagamentos pré-cadastrados. Sem saldo informado, a visão mostra a **sobra do mês** (entradas − saídas) em vez de um saldo. O saldo previsto só aparece no mês atual e a partir do saldo que *você* informar.
- **Parcelas de cartão:** o sistema reconhece `PARC 02/10`, `PARCELA 2 DE 10` e `03/10` no fim da descrição. Ao salvar a parcela 2 de 10, cria as parcelas 3 a 10 como **previstas e estimadas** (mesmo valor), uma em cada fatura seguinte; cada parcela conta como gasto no mês da sua fatura e o pagamento da fatura continua sendo a única saída de caixa. Quando a fatura real chegar, a parcela correspondente é **confirmada** (valor, data e descrição reais) em vez de duplicada; se o valor mudou, ela fica marcada para revisar. Compras antigas (a parcela traz a data da compra original) são lançadas na data de fechamento da fatura informada, com aviso. Você também pode lançar uma compra parcelada à mão (campos *Total de parcelas* e *Parcela atual*) e, ao editar/apagar, escolher se vale só para a parcela ou também para as próximas previstas.
- **Recorrências:** os lançamentos de cada mês são criados quando o mês é aberto. Ao editar uma recorrência você pode marcar **“Aplicar também aos meses futuros ainda não pagos”** (já vem marcado): o sistema mostra quantos lançamentos serão atualizados e **não mexe** nos pagos nem nos que você editou à mão em *Lançamentos*. Pausar ou encerrar uma recorrência remove os previstos que deixaram de valer.
- Valores **estimados** aparecem com “≈” e a marca *estimado*; itens a revisar têm a marca *revisar* e entram na lista de **Pendências**.

## Dados iniciais (exemplo, todos editáveis)

Carregados por `npm run db:seed` (feito pelo `setup`), em *Configurações → Dados iniciais e recorrências* e nos lançamentos de novembro/2026. **Os valores abaixo são fictícios**, só para o sistema abrir com algo para mexer; troque pelos seus na interface.

| Item | Valor | Observação |
| --- | --- | --- |
| Aluguel | R$ 1.800,00/mês | dia de vencimento não informado |
| Condomínio | R$ 520,00/mês | idem |
| Plano de saúde (minha parte) | R$ 450,00/mês | só a minha parte foi informada → **revisar** |
| Escola (minha parte) | R$ 900,00/mês | restante compartilhado/reembolsado; total pago não informado → **revisar** |
| Carro | R$ 1.500,00/mês | |
| Terapia | R$ 300,00/mês | |
| Internet | R$ 110,00/mês | |
| Coparticipação médica | R$ 80,00 (nov/2026) | pontual |
| Matrícula escolar | R$ 600,00 **anual** | mês do pagamento não informado → pendência; não entra em nenhum mês até você definir |
| Salários nov/2026 | R$ 8.000 + R$ 10.000 brutos; imposto total estimado R$ 2.700 | datas **a confirmar**. O imposto foi rateado proporcionalmente ao bruto (R$ 1.200 + R$ 1.500); é uma estimativa |
| Salário a partir de dez/2026 | R$ 10.000 bruto, imposto estimado R$ 1.500, dia 16 | líquido R$ 8.500 **estimado** |
| Transferências próprias | “Fulano de Tal” | PIX identificados como movimentação entre minhas contas |

Itens mensais gerados ficam como **previstos / pendentes** (não pagos) até você marcá-los como pagos. Recorrências geram os lançamentos do mês ao abrir esse mês; apagar um lançamento gerado não o recria.

**Primeiros passos sugeridos:** cadastre suas contas e o saldo atual (Configurações), cadastre os cartões com dia de fechamento/vencimento (Cartões e faturas), defina os dias de vencimento e corrija os itens marcados para revisar.

## Importação

1. Escolha a conta (extrato) ou o cartão (fatura) e o arquivo **CSV**, **PDF** ou **imagens** (PNG, JPG, WebP; pode escolher várias do mesmo extrato).
2. Revise a tabela: edite descrição, tipo e categoria; escolha *Importar*, *Ignorar* ou *Vincular* a um item já previsto. Nada é salvo antes de você confirmar.
3. Salve. Cada importação pode ser apagada depois, junto com os lançamentos que criou.

- **CSV:** detecta separador (`;` `,` tab), codificação (UTF-8/Latin-1), cabeçalho e formato brasileiro de datas/valores. Se não reconhecer as colunas, você mapeia manualmente. Em faturas, valor positivo = compra; há opção para inverter sinais.
- **PDF e imagens (lidos no seu navegador):** PDFs com texto são lidos com pdf.js; **imagens e PDFs escaneados** passam por OCR (Tesseract, em português) **no próprio navegador** — o arquivo nunca é enviado a ninguém e o modelo do OCR é servido pelo próprio site (sem CDN de terceiros). Só o **texto** resultante vai para a API, que o interpreta no padrão `DATA  DESCRIÇÃO  VALOR` (datas sem ano usam o mês de referência informado). Texto vindo de OCR **nunca é tratado como confiável**: as linhas chegam desmarcadas, com aviso, e você compara com a imagem (botão “Já conferi: marcar todas” quando terminar). O sistema compara a soma das linhas com o total lido na fatura. **Se não conseguir interpretar com segurança** (nenhuma linha reconhecida, soma não confere, entrada/saída ambígua), ele **não inventa valores**: avisa e permite digitar manualmente. PDFs com senha são recusados (remova a proteção antes; o sistema não pede nem guarda senhas). Dicas para o OCR: use o print inteiro, sem cortes, com boa resolução; prints em modo escuro são invertidos automaticamente.
- **Duplicatas:** reimportar o mesmo arquivo é detectado (hash de data+valor+descrição, sem guardar o texto). Também sinaliza “possível duplicata” de lançamentos já cadastrados (mesmo valor, data próxima) e permite vincular a itens previstos (ex.: o aluguel previsto vira pago em vez de duplicar).
- **Prints de apps de banco:** além do formato `DATA DESCRIÇÃO VALOR`, o leitor reconhece telas em que a data é título de grupo (“05 NOV”, “Hoje”, “Ontem”), com descrição e valor em linhas separadas ou invertidas, e valores como `- R$ 12,30`. Linhas sem data ou sem sinal ficam desmarcadas e pedem que você informe. Quando algo sai errado, a tela mostra o **texto lido** (editável, com *Reprocessar*), permite **colar o texto** do extrato e explica os números lidos (linhas, valores reconhecidos). Erros de rede, sessão expirada e servidor indisponível têm mensagens próprias.
- **Sugestões automáticas** (sempre editáveis): transferências próprias, pagamento de fatura, juros/tarifas e pagamento do cheque especial, categorias por palavras-chave e pelo histórico de descrições iguais, e as **regras aprendidas** (abaixo).

### Aprendizado local (regras aprendidas)

Quando você corrige o tipo ou a categoria de uma linha e deixa marcado **“lembrar esta correção”**, o sistema guarda uma regra e a aplica nas próximas importações (a linha ganha a marca *aprendida*). **Não é uma IA externa:** é um dicionário simples na sua própria base, sem envio de nada para fora.

- **O que é guardado:** só o nome normalizado do estabelecimento (sem acentos, números, códigos, parcelas; até 3 palavras), a categoria, o tipo e quantas vezes foi confirmada. **Nunca** valores, datas ou o texto do extrato.
- **Prioridade:** regra aprendida > categoria do histórico > palavras-chave. A regra é separada por conta e por cartão e só vale se fizer sentido (cartão só tem compras; uma entrada não vira pagamento de fatura).
- **Controle:** em *Configurações → Regras aprendidas* você edita categoria/tipo, marca *ignorar sempre*, esquece uma regra ou todas. *Apagar todos os dados* também apaga as regras.


### IA opcional (leitor de reserva)

Quando o leitor automático não entende um extrato, o botão **Tentar com IA** (na revisão da importação) pede ajuda ao Claude, da Anthropic. É **opcional, desligado por padrão** e só funciona se você ligar em *Configurações → IA (opcional)* e configurar a chave no servidor.

- **O que é enviado:** apenas o **texto** lido do extrato, nunca o arquivo. Antes, o servidor troca CPF/CNPJ, e-mails, telefones, números de cartão, agência/conta e sequências longas de dígitos por marcadores (`[CPF]`, `[TEL]`...). Valores, datas e **nomes de estabelecimentos continuam no texto**, e nomes de pessoas (ex.: PIX para “Fulano”) também, porque não dá para detectá-los com segurança. Se isso for um problema para um extrato específico, não use a IA nele.
- **A IA só propõe:** as linhas chegam **desmarcadas**, com a marca *IA: conferir*, e você revisa tudo antes de salvar. Nada é gravado pela IA.
- **Conferência de valores:** o servidor confere se cada valor devolvido existe no texto enviado (valor inexistente fica marcado) e **descarta a resposta inteira** se a maioria dos valores for inventada. Em faturas, também compara a soma com o total lido.
- **Limites:** teto de chamadas por mês (`AI_MONTHLY_LIMIT`, padrão 60), texto máximo de ~60 mil caracteres e tempo máximo de 25 s. Defina também um **limite de gasto mensal** no console da Anthropic. Um extrato de ~100 linhas custa centavos com um modelo pequeno.
- **Como ligar (produção):** crie a chave no console da Anthropic (com limite de gasto), adicione `ANTHROPIC_API_KEY` em *Vercel → Settings → Environment Variables* (opcionalmente `ANTHROPIC_MODEL` e `AI_MONTHLY_LIMIT`) e faça redeploy. Nunca coloque a chave no repositório ou no front-end. Localmente, use o `.env`.
- **Testes e CI** nunca chamam a API real (a chamada é simulada). Não há migração de banco: o interruptor e o contador ficam na tabela `settings`.

## Privacidade e dados

- **Local:** dados somente no PostgreSQL do seu computador (volume Docker `clear_balance_pgdata`), que só escuta em `127.0.0.1`. **Hospedado:** dados no **seu** projeto Supabase, acessíveis só depois do login e da checagem do seu e-mail na API; nenhum outro serviço recebe seus dados (o OCR roda no navegador), exceto se você ligar a IA opcional.
- **Não são armazenados:** senhas bancárias, tokens, CVV, número completo de cartão (apenas os 4 últimos dígitos, se informados) nem os arquivos importados — só os lançamentos aprovados na revisão.
- A API não registra corpo de requisições nem conteúdo de extratos/PDFs em logs (nível `warn`, erros sem detalhes do banco).
- **IA opcional:** desligada por padrão; se ligada, só o texto anonimizado do extrato vai à Anthropic, a seu pedido (veja *IA opcional*).
- **Regras aprendidas** guardam apenas nome de estabelecimento e classificação (veja *Aprendizado local*).
- **Apagar:** *Importação → Apagar importação*, *Configurações → Apagar tudo que foi importado* e *Apagar todos os dados* (exige digitar `APAGAR TUDO`).

### Backup local

```bash
npm run db:backup                              # cria backups/clear-balance-AAAAMMDD-HHMMSS.sql
npm run db:restore -- backups/arquivo.sql      # restaura (pede confirmação; substitui os dados atuais)
```

A pasta `backups/` está no `.gitignore` e contém dados financeiros reais: guarde-a em local seguro (ou criptografado).

## Comandos úteis

| Comando | O que faz |
| --- | --- |
| `npm run setup` | Primeira instalação completa |
| `npm run dev` | API + interface em modo desenvolvimento |
| `npm run db:up` / `db:down` | Liga/desliga o PostgreSQL (os dados permanecem no volume) |
| `npm run db:migrate` / `db:seed` | Aplica migrações / carrega dados iniciais (só uma vez). Com `MIGRATE_DATABASE_URL` definido, migra o banco remoto (Supabase) |
| `npm test` | Testes (regras financeiras, importador, parcelas, login/JWT, recorrências, API + PostgreSQL real em banco `clearbalance_test`) |
| `npm run typecheck` / `npm run build` | Verificação de tipos / build de produção |

## Estrutura

```
apps/api   API Fastify + PostgreSQL
  src/migrations    esquema SQL (valores em centavos)
  src/services      regras: overview (função pura), transações, faturas, recorrências
  src/auth.ts       validação do login (JWT do Supabase) e lista de e-mails autorizados
  src/importer      CSV, PDF/OCR (texto), parcelas, classificação, impressão digital anti-duplicata
  src/routes        endpoints REST em /api
  test              unitários + integração
apps/web   interface React (Vite) — páginas em src/pages; src/ocr.ts (leitura de PDF/imagem), src/auth.tsx (login)
api/       função Node.js da Vercel (executa a API compilada)
vercel.json  rotas, cabeçalhos de segurança (CSP, HSTS…) e limites da função
scripts    backup/restauração
```

## Hospedar de graça (Vercel + Supabase)

Resumo: o **site** (Vite) e a **API** (função Node.js em `api/index.mjs`) ficam na Vercel; o **banco** e o **login** ficam no Supabase. Os planos gratuitos bastam para uso pessoal.

### 1. Supabase
1. Crie um projeto em [supabase.com](https://supabase.com) (escolha a região mais próxima; anote a senha do banco).
2. **Authentication → Providers → Email:** mantenha *Email* ligado e **desligue “Allow new users to sign up”** (cadastro público desativado — só quem você criar entra). Em *Password strength*, exija senha forte.
3. **Authentication → Users → Add user:** crie o **seu** usuário (e-mail e senha) e marque como confirmado.
4. **Project Settings → Database → Connection string:** copie a do **Transaction pooler** (porta 6543) para `DATABASE_URL` e a do **Session pooler** (porta 5432) para `MIGRATE_DATABASE_URL`. **Project Settings → API:** copie a *Project URL* e a chave *anon/publishable*.
5. No seu computador, aplique as tabelas **uma vez** (as migrações ligam RLS em todas as tabelas, sem nenhuma policy, para que a chave pública do navegador não leia nada):
   ```bash
   MIGRATE_DATABASE_URL='postgresql://postgres.<ref>:<senha>@aws-0-<regiao>.pooler.supabase.com:5432/postgres' npm run db:migrate
   DATABASE_URL='postgresql://postgres.<ref>:<senha>@aws-0-<regiao>.pooler.supabase.com:6543/postgres' npm run db:seed   # opcional: dados iniciais
   ```
   (Nunca grave essas URLs em arquivos do repositório; use o terminal ou um `.env.local` ignorado pelo git.)

### 2. Vercel
1. Suba o projeto para um repositório Git e **importe-o na Vercel** (Framework: *Other*; o `vercel.json` já define build, saída e rotas).
2. Em **Settings → Environment Variables**, cadastre (Production):

| Variável | Valor |
| --- | --- |
| `DATABASE_URL` | URL do *Transaction pooler* (porta 6543) |
| `SUPABASE_URL` | Project URL (`https://<ref>.supabase.co`) |
| `ALLOWED_EMAILS` | seu e-mail (vários: separados por vírgula) |
| `VITE_SUPABASE_URL` | a mesma Project URL |
| `VITE_SUPABASE_ANON_KEY` | chave anon/publishable (pública por natureza; protegida por RLS e pela API) |
| `REQUIRE_MFA` | `true` para exigir verificação em duas etapas (opcional; ative o 2FA primeiro) |
| `SUPABASE_JWT_SECRET` | só se o seu projeto for antigo (assinatura HS256); em projetos novos deixe vazio |
| `DATABASE_SSL_CA` | opcional: certificado CA do Supabase (PEM) para validar o TLS do banco |

   **Não** defina `AUTH_DISABLED` (a API recusa subir em produção com ele) e **não** use a *service role key* em lugar nenhum.
3. Faça o deploy. Abra o endereço da Vercel, entre com o usuário criado e, em *Configurações → Conta e segurança*, ative a **verificação em duas etapas**.

### Como a segurança funciona
- Toda rota `/api` (exceto `/api/health`) exige um token do Supabase **válido** (assinatura, emissor, expiração) **e** e-mail em `ALLOWED_EMAILS`; com `REQUIRE_MFA`, exige também o segundo fator.
- RLS ligado e sem policies: a Data API do Supabase (chave anon) não acessa nenhuma tabela; só a nossa API, com a connection string do servidor.
- Cabeçalhos: CSP restritiva, HSTS, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`; respostas da API com `Cache-Control: no-store`; limite de requisições por IP.
- Sem recuperação de senha pelo app: se esquecer, redefina o usuário no painel do Supabase.
- Limites do plano gratuito: tempo máximo por função (configurado em 30 s), projeto Supabase pausa após inatividade prolongada (basta reativar no painel) e a primeira requisição após um tempo parado é mais lenta (partida a frio).

## O que ainda depende de integração bancária

Hoje tudo é **manual ou por arquivo**. Para automatizar mais seria necessário (por exemplo, via Open Finance/agregador autorizado):

- **Saldos reais das contas** e do limite do cheque especial (hoje você informa e atualiza).
- **Lançamentos em tempo real** de contas e cartões, sem exportar CSV/PDF.
- **Faturas oficiais**: total, fechamento, vencimento e pagamento exatos (hoje o total é estimado até você confirmar).
- **Confirmação automática de pagamentos** e das datas de crédito de salários.
- **Valores reais de impostos/descontos** do holerite (hoje estimados).
- **Reembolsos**: identificar PIX recebidos de outras pessoas e ligá-los às despesas compartilhadas.

Integrações exigem autorização do banco e credenciais; este projeto deliberadamente **não** guarda senhas nem tokens bancários.

## Limites conhecidos

- **Uma pessoa por instalação:** o login libera só os e-mails de `ALLOWED_EMAILS` e todos veem os mesmos dados (não há separação por usuário). Uma única moeda (BRL).
- **OCR pode errar** dígitos, datas e valores (principalmente em prints pequenos, borrados ou com colunas apertadas). Por isso a revisão é obrigatória e nada de OCR entra sem você marcar. A primeira leitura baixa ~4 MB de motor de OCR do próprio site e leva alguns segundos por imagem.
- **Parcelas projetadas são estimativas** (mesmo valor da parcela anterior, na fatura seguinte); a última parcela costuma ter centavos diferentes e juros de parcelamento não são previstos. Compras diferentes na mesma loja com a mesma quantidade de parcelas têm a mesma identificação — confira o aviso de revisão ao vincular.
- Pagamento parcial de fatura/rotativo: registre como pagamento e confira o total da fatura manualmente.
- Na Vercel, a API é uma função serverless: tempo máximo por requisição e partida a frio no plano gratuito.
