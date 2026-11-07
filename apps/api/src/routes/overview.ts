import type { FastifyInstance } from 'fastify';
import { badRequest } from '../errors.js';
import { MONTH_RE } from '../lib.js';
import { compareCosts, previousMonths } from '../services/compare.js';
import { buildOverview } from '../services/overviewData.js';

export async function overviewRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { month?: string } }>('/overview', async (req) => {
    const month = req.query.month;
    if (!month || !MONTH_RE.test(month)) throw badRequest('Informe o mês no formato AAAA-MM.');
    return buildOverview(month);
  });

  // Custo do mês contra a média dos até 3 meses anteriores que têm gastos (mesma regra do custo total).
  app.get<{ Querystring: { month?: string } }>('/overview/compare', async (req) => {
    const month = req.query.month;
    if (!month || !MONTH_RE.test(month)) throw badRequest('Informe o mês no formato AAAA-MM.');
    const [cur, ...prev] = await Promise.all([month, ...previousMonths(month)].map((m) => buildOverview(m)));
    const cost = (m: string, o: typeof cur) => ({ month: m, total_mine_cents: o.spending.total_mine_cents, by_category: o.spending.by_category });
    return compareCosts(cost(month, cur), previousMonths(month).map((m, i) => cost(m, prev[i])));
  });
}
