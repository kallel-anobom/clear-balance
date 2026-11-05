import { SignJWT, generateKeyPair } from 'jose';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Teste de ponta a ponta contra um PostgreSQL real, em um banco separado (clearbalance_test).
 * Se o PostgreSQL local não estiver no ar (npm run db:up), os testes são pulados.
 */
const ADMIN_URL = process.env.DATABASE_URL ?? 'postgres://clearbalance:clearbalance_local@127.0.0.1:5433/clearbalance';
const TEST_DB = 'clearbalance_test';
const TEST_URL = ADMIN_URL.replace(/\/[^/]+$/, `/${TEST_DB}`);

let available = false;
try {
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`drop database if exists ${TEST_DB} with (force)`);
  await admin.query(`create database ${TEST_DB}`);
  await admin.end();
  available = true;
} catch {
  available = false;
}
// No CI o banco precisa existir: falhar é melhor do que "passar" pulando os testes.
if (!available && process.env.REQUIRE_DB_TESTS) {
  throw new Error('REQUIRE_DB_TESTS está ligado, mas o PostgreSQL de teste não está acessível.');
}

describe.skipIf(!available)('API + PostgreSQL', () => {
  let app: Awaited<ReturnType<(typeof import('../src/server.js'))['buildApp']>>;
  let poolEnd: () => Promise<void>;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    const { seed } = await import('../src/seed.js');
    const { buildApp } = await import('../src/server.js');
    const { pool } = await import('../src/db.js');
    poolEnd = () => pool.end();
    await seed();
    app = await buildApp();
  });
  afterAll(async () => {
    await app?.close();
    await poolEnd?.();
  });

  const json = async (method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
    const res = await app.inject({ method, url: `/api${url}`, payload: payload as never });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
  };

  const upload = async (url: string, file: { name: string; content: string }, fields: Record<string, string>) => {
    const boundary = '----cb' + Math.random().toString(16).slice(2);
    const parts = Object.entries(fields).map(([k, v]) => `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n${file.content}\r\n`);
    parts.push(`--${boundary}--\r\n`);
    const res = await app.inject({
      method: 'POST', url: `/api${url}`, payload: Buffer.from(parts.join('')),
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it('dados iniciais: só o informado, com pendências visíveis e sem saldos inventados', async () => {
    const { body: o } = await json('GET', '/overview?month=2026-11');
    // Dois salários brutos (8.000 + 10.000), imposto total estimado de 2.700.
    expect(o.income.gross_cents).toBe(1800000);
    expect(o.income.deductions_cents).toBe(270000);
    expect(o.income.net_cents).toBe(1530000);
    expect(o.income.received_net_cents).toBe(0);
    // Itens mensais informados + coparticipação de novembro.
    expect(o.cash.pending_cents).toBe(180000 + 52000 + 45000 + 90000 + 150000 + 30000 + 11000 + 8000);
    expect(o.spending.realized_mine_cents).toBe(0); // nada foi confirmado como pago
    expect(o.forecast.projected_balance_cents).toBeNull(); // sem contas/saldos
    expect(o.forecast.has_estimates).toBe(true);
    expect(o.forecast.has_unconfirmed_dates).toBe(true);
    expect(o.attention.map((a: { code: string }) => a.code)).toEqual(expect.arrayContaining(['review', 'estimated', 'dates', 'yearly']));
    // Matrícula é anual: não entra no mês.
    expect(o.cash.items.some((i: { label: string }) => i.label === 'Matrícula escolar')).toBe(false);
    expect(o.yearly_without_month).toEqual(['Matrícula escolar']);
  });

  it('dezembro: salário líquido estimado, pago no dia 16', async () => {
    expect((await json('POST', '/months/2026-12/ensure')).body.created).toBeGreaterThan(0);
    expect((await json('POST', '/months/2026-12/ensure')).body.created).toBe(0); // idempotente
    const { body: o } = await json('GET', '/overview?month=2026-12');
    expect(o.income.items).toHaveLength(1);
    expect(o.income.items[0]).toMatchObject({ date: '2026-12-16', date_confirmed: true, estimated: true, gross_cents: 1000000, deductions_cents: 150000, net_cents: 850000 });
  });

  it('apagar um lançamento recorrente não o recria', async () => {
    const { body: txs } = await json('GET', '/transactions?month=2026-12&q=Internet');
    expect(txs).toHaveLength(1);
    expect((await json('DELETE', `/transactions/${txs[0].id}`)).status).toBe(204);
    await json('POST', '/months/2026-12/ensure');
    expect((await json('GET', '/transactions?month=2026-12&q=Internet')).body).toHaveLength(0);
  });

  describe('cartão, importação e fatura', () => {
    let accountId: number;
    let cardId: number;

    it('cadastra conta (saldo informado) e cartão (apenas 4 últimos dígitos)', async () => {
      const acc = await json('POST', '/accounts', { name: 'Conta corrente', balance_cents: 150000, balance_date: '2026-11-04' });
      expect(acc.status).toBe(201);
      accountId = acc.body.id;
      expect((await json('POST', '/cards', { name: 'Cartão X', last4: '1234567812345678', closing_day: 25, due_day: 5 })).status).toBe(400);
      const card = await json('POST', '/cards', { name: 'Cartão X', last4: '4321', closing_day: 25, due_day: 5 });
      expect(card.status).toBe(201);
      cardId = card.body.id;
    });

    const cardCsv = 'date,title,amount\n2026-11-02,Mercado Central,300.00\n2026-11-03,Padaria,50.50\n2026-11-04,Pagamento recebido,-900.00\n';

    it('prévia: revisão antes de salvar (nada é gravado) e pagamento da fatura ignorado por padrão', async () => {
      const before = (await json('GET', '/data/summary')).body.transactions;
      const r = await upload('/import/preview', { name: 'fatura.csv', content: cardCsv }, { target_type: 'card', target_id: String(cardId) });
      expect(r.status).toBe(200);
      expect(r.body.rows).toHaveLength(3);
      expect(r.body.rows.map((x: { action: string }) => x.action)).toEqual(['create', 'create', 'skip']);
      expect((await json('GET', '/data/summary')).body.transactions).toBe(before);
    });

    let invoiceId: number;
    it('importa compras: gasto pela data da compra, na fatura correta; reimportar detecta duplicatas', async () => {
      const prev = await upload('/import/preview', { name: 'f.csv', content: cardCsv }, { target_type: 'card', target_id: String(cardId) });
      const rows = prev.body.rows.map((x: Record<string, unknown>) => ({ ...x, category_id: null }));
      const c = await json('POST', '/import/commit', { target_type: 'card', target_id: cardId, source_kind: 'csv', rows });
      expect(c.status).toBe(201);
      expect(c.body).toMatchObject({ created: 2, linked: 0, skipped: 1 });

      const { body } = await json('GET', `/invoices?card_id=${cardId}`);
      expect(body.invoices).toHaveLength(1);
      const inv = body.invoices[0];
      invoiceId = inv.id;
      expect(inv).toMatchObject({ due_date: '2026-12-05', closing_date: '2026-11-25', lines_total_cents: 35050, amount_cents: 35050, amount_estimated: true, status: 'open', paid_on: null });

      const again = await upload('/import/preview', { name: 'f.csv', content: cardCsv }, { target_type: 'card', target_id: String(cardId) });
      expect(again.body.rows.slice(0, 2).map((x: { duplicate: { level: string } }) => x.duplicate.level)).toEqual(['exact', 'exact']);
      expect(again.body.rows.slice(0, 2).map((x: { action: string }) => x.action)).toEqual(['skip', 'skip']);
    });

    it('compras de novembro contam em novembro; a fatura vence em dezembro e não duplica o gasto', async () => {
      const nov = (await json('GET', '/overview?month=2026-11')).body;
      expect(nov.spending.realized_mine_cents).toBe(35050);
      expect(nov.cash.items.some((i: { kind: string }) => i.kind === 'fatura')).toBe(false); // vence em dezembro
      const dec = (await json('GET', '/overview?month=2026-12')).body;
      expect(dec.cash.items.find((i: { kind: string }) => i.kind === 'fatura')).toMatchObject({ amount_cents: 35050, estimated: true, status: 'pending', date: '2026-12-05' });
      expect(dec.spending.realized_mine_cents).toBe(0);
    });

    it('pagar a fatura cria uma saída de caixa e não vira despesa', async () => {
      await json('PATCH', `/invoices/${invoiceId}`, { statement_total_cents: 35050 });
      const pay = await json('POST', `/invoices/${invoiceId}/pay`, { account_id: accountId, paid_on: '2026-12-05' });
      expect(pay.status).toBe(201);
      expect(pay.body).toMatchObject({ type: 'invoice_payment', total_cents: 35050, my_share_cents: null, category_id: null });
      const inv = (await json('GET', `/invoices/${invoiceId}`)).body;
      expect(inv).toMatchObject({ paid_on: '2026-12-05', status: 'paid', mismatch_cents: 0 });
      const dec = (await json('GET', '/overview?month=2026-12')).body;
      expect(dec.cash.items.filter((i: { kind: string }) => i.kind === 'fatura')).toHaveLength(1); // só o pagamento
      expect(dec.spending.realized_mine_cents).toBe(0);
      expect(dec.cash.paid_cents).toBe(35050);
      // Apagar o pagamento reabre a fatura.
      await json('DELETE', `/transactions/${pay.body.id}`);
      expect((await json('GET', `/invoices/${invoiceId}`)).body.paid_on).toBeNull();
    });

    it('extrato: PIX para "Fulano de Tal" é transferência, juros são despesa, aluguel previsto é vinculado', async () => {
      await json('POST', '/months/2026-11/ensure');
      const csv = [
        'Data;Histórico;Valor',
        '06/11/2026;PIX ENVIADO FULANO DE TAL;-500,00',
        '07/11/2026;JUROS LIMITE DA CONTA;-45,00',
        '08/11/2026;PAGAMENTO CHEQUE ESPECIAL;-100,00',
        '09/11/2026;ALUGUEL IMOBILIARIA;-1.800,00',
      ].join('\n');
      const prev = await upload('/import/preview', { name: 'e.csv', content: csv }, { target_type: 'account', target_id: String(accountId) });
      const rows = prev.body.rows;
      expect(rows.map((r: { type: string }) => r.type)).toEqual(['transfer', 'expense', 'overdraft_payment', 'expense']);
      expect(rows[3].duplicate).toMatchObject({ level: 'possible', description: 'Aluguel' });
      expect(rows[3].action).toBe('link');

      const commitRows = rows.map((r: Record<string, unknown>) => ({
        ...r,
        link_to_id: r.action === 'link' ? (r.duplicate as { id: number }).id : null,
      }));
      const c = await json('POST', '/import/commit', { target_type: 'account', target_id: accountId, source_kind: 'csv', rows: commitRows });
      expect(c.body).toMatchObject({ created: 3, linked: 1 });

      const nov = (await json('GET', '/overview?month=2026-11')).body;
      // Gasto realizado: compras do cartão (350,50) + juros (45) + aluguel pago (1.800,00). Transferência e cheque especial não entram.
      expect(nov.spending.realized_mine_cents).toBe(35050 + 4500 + 180000);
      expect(nov.overdraft.costs_in_month_cents).toBe(4500);
      expect(nov.overdraft.amortized_in_month_cents).toBe(10000);
      const aluguel = nov.cash.items.find((i: { label: string }) => i.label === 'Aluguel');
      expect(aluguel).toMatchObject({ status: 'paid', date: '2026-11-09' });
      // Transferência não aparece como saída.
      expect(nov.cash.items.some((i: { label: string }) => i.label.includes('FULANO DE TAL'))).toBe(false);

      // Reimportar o mesmo extrato: tudo duplicado.
      const again = await upload('/import/preview', { name: 'e.csv', content: csv }, { target_type: 'account', target_id: String(accountId) });
      expect(again.body.rows.map((r: { duplicate: { level: string } | null }) => r.duplicate?.level)).toEqual(['exact', 'exact', 'exact', 'exact']);
    });

    it('despesa compartilhada: minha parte, parte dos outros e reembolso recebido', async () => {
      const exp = await json('POST', '/transactions', {
        type: 'expense', description: 'Escola (total)', account_id: accountId, occurred_on: '2026-11-10',
        total_cents: 200000, my_share_cents: 128000, shared_with: 'Ana',
      });
      expect(exp.status).toBe(201);
      let o = (await json('GET', '/overview?month=2026-11')).body;
      expect(o.reimbursements.items.find((i: { id: number }) => i.id === exp.body.id)).toMatchObject({ others_cents: 72000, pending_cents: 72000 });
      const r = await json('POST', '/transactions', {
        type: 'reimbursement', description: 'Reembolso Ana', account_id: accountId, paid_on: '2026-11-15',
        total_cents: 72000, reimbursement_for_id: exp.body.id,
      });
      expect(r.status).toBe(201);
      o = (await json('GET', '/overview?month=2026-11')).body;
      expect(o.reimbursements.items.find((i: { id: number }) => i.id === exp.body.id)).toBeUndefined();
      expect(o.reimbursements.received_in_month_cents).toBe(72000);
      expect((await json('POST', '/transactions', { type: 'expense', description: 'x', occurred_on: '2026-11-10', total_cents: 1000, my_share_cents: 2000 })).status).toBe(400);
    });

    it('apagar uma importação remove só o que ela criou', async () => {
      const { body: batches } = await json('GET', '/data/imports');
      expect(batches.length).toBeGreaterThanOrEqual(2);
      const cardBatch = batches.find((b: { transactions: number }) => b.transactions === 2);
      expect((await json('DELETE', `/data/imports/${cardBatch.id}`)).status).toBe(200);
      // A fatura com total confirmado por mim permanece, mas sem as compras importadas.
      const invs = (await json('GET', `/invoices?card_id=${cardId}`)).body.invoices;
      expect(invs).toHaveLength(1);
      expect(invs[0]).toMatchObject({ lines_count: 0, statement_total_cents: 35050 });
      const nov = (await json('GET', '/overview?month=2026-11')).body;
      expect(nov.spending.realized_mine_cents).toBe(4500 + 180000 + 128000);
    });
  });

  describe('parcelas de cartão', () => {
    let cardId: number;
    const commit = (rows: Record<string, unknown>[], extra: Record<string, unknown> = {}, source = 'csv') =>
      json('POST', '/import/commit', { target_type: 'card', target_id: cardId, source_kind: source, rows, ...extra });
    const cardTxs = async () => (await json('GET', `/transactions?card_id=${cardId}`)).body as Record<string, any>[];

    it('texto lido de imagem (OCR): confiança baixa, linhas desmarcadas e parcela detectada', async () => {
      cardId = (await json('POST', '/cards', { name: 'Cartão Parcelas', closing_day: 25, due_day: 5 })).body.id;
      const text = '04/10 MAGAZINE LUIZA PARC 02/04 150,00\n10/10 PADARIA 30,00\nTotal da fatura 180,00';
      const r = await json('POST', '/import/preview-text', { target_type: 'card', target_id: cardId, ref_month: '2026-10', origin: 'ocr', text });
      expect(r.status).toBe(200);
      expect(r.body.source_kind).toBe('image');
      expect(r.body.pdf.confidence).toBe('low');
      expect(r.body.rows.map((x: { action: string }) => x.action)).toEqual(['skip', 'skip']);
      expect(r.body.rows[0].installment).toMatchObject({ no: 2, total: 4 });
      expect(r.body.rows[1].installment).toBeNull();

      // Ao confirmar, a parcela 2/4 vira compra real e as parcelas 3 e 4 são projetadas nas próximas faturas.
      const rows = r.body.rows.map((x: Record<string, unknown>) => ({ ...x, action: 'create' }));
      const c = await commit(rows, { invoice_due_date: '2026-11-05' }, 'image');
      expect(c.status).toBe(201);
      expect(c.body.created).toBe(2);
      const txs = await cardTxs();
      const real = txs.find((t) => t.installment_no === 2)!;
      expect(real).toMatchObject({ status: 'paid', is_projected: false, total_cents: 15000, installment_total: 4, occurred_on: '2026-10-04' });
      const projected = txs.filter((t) => t.is_projected).sort((a, b) => a.installment_no - b.installment_no);
      expect(projected.map((t) => t.installment_no)).toEqual([3, 4]);
      expect(projected[0]).toMatchObject({ status: 'scheduled', is_estimate: true, total_cents: 15000, occurred_on: '2026-11-25', month_ref: '2026-11' });
      expect(projected[1]).toMatchObject({ occurred_on: '2026-12-25', month_ref: '2026-12' });
      expect(projected[0].description).toBe('MAGAZINE LUIZA - parcela 3/4');

      // Cada parcela cai na fatura certa e entra na previsão do mês (sem contar o gasto duas vezes).
      const invs = (await json('GET', `/invoices?card_id=${cardId}`)).body.invoices.map((i: { due_date: string; lines_total_cents: number }) => [i.due_date, i.lines_total_cents]).sort();
      expect(invs).toEqual([['2026-11-05', 18000], ['2026-12-05', 15000], ['2027-01-05', 15000]]);
      const dec = (await json('GET', '/overview?month=2026-12')).body;
      expect(dec.cash.items.find((i: { kind: string; date: string }) => i.kind === 'fatura' && i.date === '2026-12-05')).toMatchObject({ amount_cents: 15000, estimated: true });
      expect(dec.installments).toMatchObject({ in_month_cents: 15000, in_month_count: 1, remaining_count: 0, remaining_cents: 0, last_month: '2026-12' });
      const nov = (await json('GET', '/overview?month=2026-11')).body;
      expect(nov.installments).toMatchObject({ in_month_cents: 15000, in_month_count: 1, remaining_count: 1, remaining_cents: 15000, last_month: '2026-12' });

      const list = (await json('GET', `/installments?card_id=${cardId}`)).body;
      expect(list.groups).toHaveLength(1);
      expect(list.groups[0]).toMatchObject({ description: 'MAGAZINE LUIZA', total: 4, last_real_no: 2, remaining_count: 2, remaining_mine_cents: 30000, next_month: '2026-11', last_month: '2026-12' });
      expect(list.by_month.map((m: { month: string }) => m.month)).toEqual(['2026-11', '2026-12']);
    });

    it('a parcela real da fatura seguinte confirma a prevista, sem duplicar', async () => {
      const csv = 'date,title,amount\n2026-11-04,MAGAZINE LUIZA PARC 03/04,152.00\n';
      const prev = await upload('/import/preview', { name: 'f.csv', content: csv }, { target_type: 'card', target_id: String(cardId) });
      const row = prev.body.rows[0];
      expect(row.installment).toMatchObject({ no: 3, total: 4 });
      expect(row.duplicate).toMatchObject({ level: 'possible', status: 'scheduled' });
      expect(row.action).toBe('link');
      const before = (await cardTxs()).length;
      const c = await commit([{ ...row, link_to_id: row.duplicate.id }], { invoice_due_date: '2026-12-05' });
      expect(c.body).toMatchObject({ created: 0, linked: 1 });
      const txs = await cardTxs();
      expect(txs).toHaveLength(before); // nada novo
      const p3 = txs.find((t) => t.installment_no === 3)!;
      expect(p3).toMatchObject({ is_projected: false, status: 'paid', total_cents: 15200, needs_review: true, description: 'MAGAZINE LUIZA PARC 03/04' });
      expect(p3.review_note).toMatch(/mudou/);
      expect(txs.filter((t) => t.is_projected).map((t) => t.installment_no)).toEqual([4]);

      // Importar de novo a mesma parcela já confirmada: duplicata exata.
      const again = await upload('/import/preview', { name: 'f.csv', content: csv }, { target_type: 'card', target_id: String(cardId) });
      expect(again.body.rows[0].duplicate.level).toBe('exact');
      expect(again.body.rows[0].action).toBe('skip');
    });

    it('parcela de compra antiga: cai na fatura informada, na data de fechamento, com aviso', async () => {
      const csv = 'date,title,amount\n2026-08-12,LOJA ANTIGA PARC 05/07,100.00\n';
      const prev = await upload('/import/preview', { name: 'f.csv', content: csv }, { target_type: 'card', target_id: String(cardId) });
      const c = await commit(prev.body.rows, { invoice_due_date: '2027-01-05' });
      expect(c.body.created).toBe(1);
      const txs = (await cardTxs()).filter((t) => t.installment_total === 7);
      const real = txs.find((t) => !t.is_projected)!;
      expect(real).toMatchObject({ installment_no: 5, occurred_on: '2026-12-25', needs_review: true });
      expect(real.review_note).toMatch(/12\/08\/2026/);
      expect(txs.filter((t) => t.is_projected).map((t) => t.installment_no).sort()).toEqual([6, 7]);
    });

    it('compra parcelada digitada à mão; apagar "esta e as próximas"; editar as próximas', async () => {
      const mk = (description: string) => json('POST', '/transactions', {
        type: 'expense', description, card_id: cardId, occurred_on: '2026-11-10', total_cents: 9000, installment_total: 3,
      });
      const a = await mk('Notebook');
      expect(a.status).toBe(201);
      expect(a.body).toMatchObject({ installment_no: 1, installment_total: 3, is_projected: false });
      const group = (await cardTxs()).filter((t) => t.installment_group === a.body.installment_group);
      expect(group.map((t) => t.installment_no).sort()).toEqual([1, 2, 3]);
      expect(group.filter((t) => t.is_projected).every((t) => t.total_cents === 9000)).toBe(true);
      // Mesma compra de novo: bloqueada (parcelas iguais já existem).
      expect((await mk('Notebook')).status).toBe(409);
      // Parcela atual maior que o total é recusada.
      expect((await json('POST', '/transactions', { type: 'expense', description: 'X', card_id: cardId, occurred_on: '2026-11-10', total_cents: 100, installment_total: 3, installment_no: 4 })).status).toBe(400);

      // Corrige o valor da parcela 1 e leva às próximas previstas.
      expect((await json('PATCH', `/transactions/${a.body.id}?scope=following`, { total_cents: 9500, my_share_cents: 9500 })).status).toBe(200);
      const edited = (await cardTxs()).filter((t) => t.installment_group === a.body.installment_group);
      expect(edited.map((t) => t.total_cents)).toEqual([9500, 9500, 9500]);

      // Parcelamento não pode ser trocado por PATCH.
      const patchTotal = await json('PATCH', `/transactions/${a.body.id}`, { installment_total: 10 });
      expect((await json('GET', `/transactions/${a.body.id}`)).body.installment_total).toBe(3);
      expect(patchTotal.status).toBe(200);

      expect((await json('DELETE', `/transactions/${a.body.id}?scope=following`)).status).toBe(204);
      expect((await cardTxs()).filter((t) => t.installment_group === a.body.installment_group)).toHaveLength(0);
    });

    it('apagar a importação também remove as parcelas projetadas dela', async () => {
      const csv = 'date,title,amount\n2026-11-12,CELULAR PARC 01/03,200.00\n';
      const prev = await upload('/import/preview', { name: 'f.csv', content: csv }, { target_type: 'card', target_id: String(cardId) });
      const c = await commit(prev.body.rows);
      const group = (await cardTxs()).filter((t) => t.description.startsWith('CELULAR'));
      expect(group).toHaveLength(3);
      expect((await json('DELETE', `/data/imports/${c.body.batch_id}`)).status).toBe(200);
      expect((await cardTxs()).filter((t) => t.description.startsWith('CELULAR'))).toHaveLength(0);
    });
  });

  describe('recorrência: aplicar mudanças aos meses futuros', () => {
    it('atualiza só o que está previsto e não foi editado à mão; prévia não grava nada', async () => {
      const body = {
        description: 'Academia', type: 'expense', frequency: 'monthly', day_of_month: 10, start_month: '2027-01', total_cents: 10000,
      };
      const rec = await json('POST', '/recurring', body);
      expect(rec.status).toBe(201);
      for (const m of ['2027-01', '2027-02', '2027-03']) await json('POST', `/months/${m}/ensure`);
      const find = async () => (await json('GET', '/transactions?q=Academia')).body as Record<string, any>[];
      expect(await find()).toHaveLength(3);
      const patch = (b: Record<string, unknown>) => json('PATCH', `/recurring/${rec.body.id}`, { ...body, ...b });

      // Sem apply: só a recorrência muda (comportamento antigo).
      await patch({ total_cents: 11000 });
      expect((await find()).map((t) => t.total_cents)).toEqual([10000, 10000, 10000]);

      // Prévia: conta, mas não grava.
      const dry = await patch({ total_cents: 12000, apply: 'future_unpaid', dry_run: true, from_month: '2027-01' });
      expect(dry.body).toMatchObject({ dry_run: true, propagated: { updated: 3, removed: 0 } });
      expect((await json('GET', '/recurring')).body.find((r: { id: number }) => r.id === rec.body.id).total_cents).toBe(11000);
      expect((await find()).map((t) => t.total_cents)).toEqual([10000, 10000, 10000]);

      // Fevereiro editado à mão e março já pago não são tocados.
      const txs = (await find()).sort((a, b) => a.month_ref.localeCompare(b.month_ref));
      await json('PATCH', `/transactions/${txs[1].id}`, { total_cents: 10500, my_share_cents: 10500 });
      await json('PATCH', `/transactions/${txs[2].id}`, { status: 'paid', paid_on: '2027-03-10' });
      const res = await patch({ total_cents: 12000, apply: 'future_unpaid', from_month: '2027-01' });
      expect(res.body.propagated).toEqual({ updated: 1, removed: 0 });
      const after = (await find()).sort((a, b) => a.month_ref.localeCompare(b.month_ref));
      expect(after.map((t) => t.total_cents)).toEqual([12000, 10500, 10000]);
      expect(after[1].manually_edited).toBe(true);

      // Dia e descrição também propagam; pausar remove os previstos que sobram.
      await patch({ total_cents: 12000, day_of_month: 15, description: 'Academia Smart', apply: 'future_unpaid', from_month: '2027-01' });
      const jan = (await json('GET', '/transactions?q=Academia Smart&month=2027-01')).body[0];
      expect(jan).toMatchObject({ due_date: '2027-01-15' });
      const off = await patch({ description: 'Academia Smart', active: false, apply: 'future_unpaid', from_month: '2027-01' });
      expect(off.body.propagated).toEqual({ updated: 0, removed: 1 });
      expect((await json('GET', '/transactions?q=Academia')).body).toHaveLength(2); // editado e pago permanecem
    });
  });

  describe('login (API com autenticação ligada)', () => {
    it('exige token válido de e-mail autorizado; /health é público', async () => {
      const { publicKey, privateKey } = await generateKeyPair('ES256');
      const issuer = 'https://proj.supabase.co/auth/v1';
      const { buildApp } = await import('../src/server.js');
      const secured = await buildApp({ auth: { disabled: false, issuer, key: publicKey, algorithms: ['ES256'], allowedEmails: ['eu@exemplo.com'], requireMfa: false } });
      const token = (email: string, exp = '1h') =>
        new SignJWT({ email }).setProtectedHeader({ alg: 'ES256' }).setSubject('u1').setIssuer(issuer).setAudience('authenticated').setIssuedAt().setExpirationTime(exp).sign(privateKey);
      const get = async (url: string, bearer?: string) =>
        secured.inject({ method: 'GET', url, headers: bearer ? { authorization: `Bearer ${bearer}` } : {} });

      expect((await get('/api/health')).statusCode).toBe(200);
      for (const url of ['/api/overview?month=2026-11', '/api/transactions', '/api/accounts', '/api/data/summary']) {
        expect((await get(url)).statusCode).toBe(401);
      }
      expect((await get('/api/accounts', 'lixo')).statusCode).toBe(401);
      expect((await get('/api/accounts', await token('eu@exemplo.com', '-1m'))).statusCode).toBe(401);
      expect((await get('/api/accounts', await token('intruso@exemplo.com'))).statusCode).toBe(403);
      const ok = await get('/api/accounts', await token('EU@exemplo.com'));
      expect(ok.statusCode).toBe(200);
      expect(ok.headers['cache-control']).toBe('no-store');
      // Também protege escrita e importação.
      expect((await secured.inject({ method: 'POST', url: '/api/data/wipe', payload: { confirm: 'APAGAR TUDO' } })).statusCode).toBe(401);
      await secured.close();
    });
  });

  it('apagar tudo exige confirmação explícita', async () => {
    expect((await json('POST', '/data/wipe', {})).status).toBe(400);
    expect((await json('POST', '/data/wipe', { confirm: 'APAGAR TUDO' })).status).toBe(200);
    expect((await json('GET', '/data/summary')).body).toMatchObject({ transactions: 0, accounts: 0, cards: 0 });
  });

  it('depois de apagar tudo, os dados iniciais podem ser carregados de novo', async () => {
    const { seed } = await import('../src/seed.js');
    expect(await seed()).toBe(true);
    expect((await json('GET', '/data/summary')).body.transactions).toBe(10);
  });
});
