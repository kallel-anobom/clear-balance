import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import { ZodError } from 'zod';
import { requireAuth, resolveAuthConfig, type AuthConfig } from './auth.js';
import { config } from './config.js';
import { HttpError } from './errors.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
import { catalogRoutes } from './routes/catalog.js';
import { dataRoutes } from './routes/data.js';
import { importRoutes } from './routes/imports.js';
import { installmentRoutes } from './routes/installments.js';
import { invoiceRoutes } from './routes/invoices.js';
import { overviewRoutes } from './routes/overview.js';
import { recurringRoutes } from './routes/recurring.js';
import { ruleRoutes } from './routes/rules.js';
import { transactionRoutes } from './routes/transactions.js';

export async function buildApp(options: { auth?: AuthConfig } = {}) {
  // Falha cedo (antes de subir) se a autenticação estiver mal configurada ou desligada em produção.
  const auth = options.auth ?? resolveAuthConfig();
  const app = Fastify({
    trustProxy: config.isServerless,
    // Privacidade: só avisos/erros são registrados (nível "warn"); nunca corpo de requisição nem conteúdo de arquivos.
    logger: { level: 'warn' },
    bodyLimit: 5 * 1024 * 1024,
  });

  await app.register(rateLimit, { max: 600, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 1, fields: 20 } });

  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const where = issue.path.length ? ` (${issue.path.join('.')})` : '';
      return reply.code(400).send({ error: `${issue.message}${where}` });
    }
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message });
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'Arquivo grande demais (limite de 15 MB).' });
    if (err.code === '23505') return reply.code(409).send({ error: 'Já existe um registro igual.' });
    if (err.code === '23503') return reply.code(409).send({ error: 'Este registro está em uso por outros dados.' });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: 'Requisição inválida.' });
    // Só registra o tipo do erro — mensagens do banco podem conter valores dos lançamentos.
    app.log.error({ code: err.code, name: err.name }, 'erro interno');
    return reply.code(500).send({ error: 'Erro interno do servidor. Tente de novo; se continuar, veja os logs da API (terminal local ou Logs da função no Vercel).' });
  });

  await app.register(
    async (api) => {
      // Respostas com dados financeiros nunca devem ficar em cache de navegador/CDN.
      api.addHook('onSend', async (_req, reply) => {
        reply.header('Cache-Control', 'no-store');
      });
      requireAuth(api, auth);
      api.get('/health', async () => {
        await pool.query('select 1');
        return { ok: true };
      });
      await api.register(catalogRoutes);
      await api.register(transactionRoutes);
      await api.register(invoiceRoutes);
      await api.register(installmentRoutes);
      await api.register(recurringRoutes);
      await api.register(overviewRoutes);
      await api.register(importRoutes);
      await api.register(dataRoutes);
      await api.register(ruleRoutes);
    },
    { prefix: '/api' },
  );
  return app;
}

async function main() {
  await migrate();
  const app = await buildApp();
  // Escuta apenas neste computador. O frontend acessa a API pelo proxy do Vite.
  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`API em http://127.0.0.1:${config.port}/api`);
}

import { fileURLToPath } from 'node:url';
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error('Falha ao iniciar a API:', e.code === 'ECONNREFUSED' ? 'banco indisponível (rode "npm run db:up").' : e.message);
    process.exit(1);
  });
}
