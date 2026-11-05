import { pool, withTx } from './db.js';
import { migrate } from './migrate.js';
import { ensureMonth } from './services/recurring.js';
import { createTransaction } from './services/transactions.js';

/**
 * Dados iniciais de exemplo (valores fictícios; troque pelos seus na interface). Tudo é editável na interface.
 * Não há contas, saldos, cartões nem datas inventadas. O que falta fica marcado "para revisar".
 */
export async function seed() {
  await migrate();
  const done = await pool.query(`select 1 from settings where key = 'seeded'`);
  if (done.rowCount) {
    console.log('Dados iniciais já foram carregados antes. Nada a fazer.');
    return false;
  }
  await withTx(async (c) => {
    const cat = async (slug: string) => (await c.query('select id from categories where slug = $1', [slug])).rows[0].id as number;
    const moradia = await cat('moradia');
    const saude = await cat('saude');
    const educacao = await cat('educacao');
    const transporte = await cat('transporte');
    const servicos = await cat('servicos');
    const salario = await cat('salario');

    // PIX para "Fulano de Tal" = movimentação entre minhas contas.
    await c.query(`insert into settings (key, value) values ('own_transfer_names', $1) on conflict (key) do nothing`, [JSON.stringify(['Fulano de Tal'])]);

    const NOV = '2026-11';
    const recurring = async (r: Record<string, unknown>) =>
      c.query(
        `insert into recurring_items
          (description, type, category_id, frequency, day_of_month, month_of_year, start_month, total_cents, my_share_cents,
           gross_cents, deductions_cents, shared_with, is_estimate, needs_review, review_note, notes)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          r.description, r.type ?? 'expense', r.category, r.frequency ?? 'monthly', r.day ?? null, r.monthOfYear ?? null,
          r.start ?? null, r.total, r.share ?? null, r.gross ?? null, r.deductions ?? null, r.shared ?? null,
          r.estimate ?? false, r.review ?? false, r.reviewNote ?? null, r.notes ?? null,
        ],
      );
    const NO_DAY = 'Dia de vencimento não informado — defina em Configurações → Recorrências.';

    await recurring({ description: 'Aluguel', category: moradia, total: 180000, share: 180000, start: NOV, notes: NO_DAY });
    await recurring({ description: 'Condomínio', category: moradia, total: 52000, share: 52000, start: NOV, notes: NO_DAY });
    await recurring({
      description: 'Plano de saúde (minha parte)', category: saude, total: 45000, share: 45000, start: NOV, notes: NO_DAY,
      review: true, reviewNote: 'Só a minha parte foi informada. Informe o total pago pela conta e quanto é de outras pessoas.',
    });
    await recurring({
      description: 'Escola (minha parte)', category: educacao, total: 90000, share: 90000, start: NOV, notes: NO_DAY,
      review: true,
      reviewNote: 'Só a minha parte (R$ 900,00) foi informada; o restante é compartilhado/reembolsado. Informe o total pago e quem reembolsa.',
    });
    await recurring({ description: 'Carro', category: transporte, total: 150000, share: 150000, start: NOV, notes: NO_DAY });
    await recurring({ description: 'Terapia', category: saude, total: 30000, share: 30000, start: NOV, notes: NO_DAY });
    await recurring({ description: 'Internet', category: servicos, total: 11000, share: 11000, start: NOV, notes: NO_DAY });
    // Anual: não é mensal e o mês do pagamento não foi informado.
    await recurring({
      description: 'Matrícula escolar', category: educacao, frequency: 'yearly', total: 60000, share: 60000,
      review: true, reviewNote: 'Paga uma vez ao ano. Informe o mês do pagamento em Configurações → Recorrências para entrar na previsão.',
    });
    // A partir de dezembro de 2026: bruto 10.000, imposto estimado 1.500, pago no dia 16.
    await recurring({
      description: 'Salário', type: 'income', category: salario, day: 16, start: '2026-12', total: 850000,
      gross: 1000000, deductions: 150000, estimate: true,
      notes: 'Líquido calculado (bruto − imposto estimado). Confirme o valor real quando o salário cair.',
    });

    // Lançamentos pontuais de novembro de 2026.
    await createTransaction(c, {
      type: 'expense', description: 'Coparticipação médica', category_id: saude, status: 'scheduled', month_ref: NOV,
      date_confirmed: false, total_cents: 8000, my_share_cents: 8000,
      notes: 'Valor informado para novembro de 2026. Data de pagamento não informada.',
    });
    // Imposto total estimado de R$ 2.700 para os dois salários, rateado proporcionalmente ao bruto
    // (8.000 → 1.200 e 10.000 → 1.500). É uma estimativa; ajuste quando souber os valores reais.
    const salaryNote = 'Imposto: parte do total estimado de R$ 2.700 (nov/2026), rateada proporcionalmente ao salário bruto.';
    await createTransaction(c, {
      type: 'income', description: 'Salário (R$ 8.000 bruto)', category_id: salario, status: 'scheduled', month_ref: NOV,
      date_confirmed: false, gross_cents: 800000, deductions_cents: 120000, total_cents: 0, is_estimate: true,
      needs_review: true, review_note: 'A data do pagamento ainda precisa ser confirmada.', notes: salaryNote,
    });
    await createTransaction(c, {
      type: 'income', description: 'Salário (R$ 10.000 bruto)', category_id: salario, status: 'scheduled', month_ref: NOV,
      date_confirmed: false, gross_cents: 1000000, deductions_cents: 150000, total_cents: 0, is_estimate: true,
      needs_review: true, review_note: 'A data do pagamento em novembro não foi informada. Confirme.', notes: salaryNote,
    });

    await ensureMonth(c, NOV);
    await c.query(`insert into settings (key, value) values ('seeded', 'true')`);
  });
  console.log('Dados iniciais carregados (novembro de 2026). Revise as pendências na tela "Visão do mês".');
  return true;
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  seed()
    .catch((e) => {
      console.error('Falha ao carregar dados iniciais:', e.message);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
