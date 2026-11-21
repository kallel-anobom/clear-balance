import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { pool } from '../db.js';
import { HttpError, badRequest } from '../errors.js';
import { AiError } from '../importer/anthropic.js';
import { MONTH_RE, monthOf, todayISO } from '../lib.js';
import { countAiCall, getAiState } from '../services/ai.js';
import { loadChecks } from '../services/checksData.js';
import { loadOutlook, MAX_OUTLOOK_MONTHS } from '../services/outlookData.js';
import { loadReport } from '../services/reportData.js';
import { buildOverview, loadComparison } from '../services/overviewData.js';
import { buildFacts, writeSummary } from '../services/summary.js';
import { loadSubscriptions } from './subscriptions.js';

function monthOrFail(month: string | undefined): string {
  if (!month || !MONTH_RE.test(month)) throw badRequest('Informe o mês no formato AAAA-MM.');
  return month;
}

export async function overviewRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { month?: string } }>('/overview', async (req) => buildOverview(monthOrFail(req.query.month)));

  // Custo do mês contra a média dos até 3 meses anteriores que têm gastos (mesma regra do custo total).
  app.get<{ Querystring: { month?: string } }>('/overview/compare', async (req) => loadComparison(monthOrFail(req.query.month)));

  // Conferência dos números do mês: checagens determinísticas (sem IA) de onde o valor pode estar errado.
  app.get<{ Querystring: { month?: string } }>('/overview/checks', async (req) => loadChecks(monthOrFail(req.query.month)));

  // Relatório para baixar: conferência, previsão e faturas do mês (e vizinhos). Sem descrições, salvo `lines=1`.
  app.get<{ Querystring: { month?: string; lines?: string } }>('/overview/report', async (req) =>
    loadReport(monthOrFail(req.query.month), req.query.lines === '1'));

  // Quanto vai sair da conta nos próximos meses: o que já está lançado nas faturas e a estimativa ao fechar.
  app.get<{ Querystring: { from?: string; months?: string } }>('/overview/outlook', async (req) => {
    const from = req.query.from ? monthOrFail(req.query.from) : monthOf(todayISO());
    const months = req.query.months === undefined ? 3 : Number(req.query.months);
    if (!Number.isInteger(months) || months < 1 || months > MAX_OUTLOOK_MONTHS) {
      throw badRequest(`Informe de 1 a ${MAX_OUTLOOK_MONTHS} meses.`);
    }
    return loadOutlook(from, months);
  });

  // Resumo do mês escrito por IA (opcional, só ao clicar). A IA recebe apenas agregados já calculados aqui;
  // o texto é descartado se citar qualquer número que não esteja nesses agregados.
  app.post<{ Querystring: { month?: string } }>('/overview/summary', async (req) => {
    const month = monthOrFail(req.query.month);
    const state = await getAiState(pool);
    if (!state.enabled) throw new HttpError(403, 'A IA está desligada. Ligue em Configurações › IA (opcional).');
    if (!state.available) throw new HttpError(503, 'A IA não está configurada no servidor (falta a chave da Anthropic).');
    if (state.calls >= state.limit) {
      throw new HttpError(429, `Limite de ${state.limit} usos da IA neste mês atingido. Espere o próximo mês.`);
    }

    const o = await buildOverview(month);
    const [compare, subs] = await Promise.all([loadComparison(month, o), loadSubscriptions()]);
    const set = buildFacts({
      month,
      spending: o.spending,
      income: o.income,
      forecast: o.forecast,
      installments: o.installments,
      compare,
      subscriptions: { count: subs.items.length, total_monthly_cents: subs.total_monthly_cents },
    });

    await countAiCall(pool, state);
    try {
      const { text } = await writeSummary(set, {
        apiKey: config.anthropicApiKey,
        model: config.anthropicModel,
        timeoutMs: config.aiTimeoutMs,
      });
      // `facts` volta para a tela mostrar exatamente o que foi enviado à IA.
      return { month, model: config.anthropicModel, ...text, facts: set.facts };
    } catch (e) {
      if (e instanceof AiError) throw new HttpError(e.status, e.message);
      throw e;
    }
  });
}
