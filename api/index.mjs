// Função Node.js da Vercel: executa a API Fastify (compilada em apps/api/dist durante o build).
let appPromise;

function getApp() {
  appPromise ??= import('../apps/api/dist/server.js')
    .then(({ buildApp }) => buildApp())
    .then(async (app) => {
      await app.ready();
      return app;
    })
    .catch((err) => {
      appPromise = undefined; // tenta de novo na próxima requisição
      throw err;
    });
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const app = await getApp();
    app.server.emit('request', req, res);
  } catch (err) {
    // Só o tipo do erro vai para o log da Vercel; mensagens podem expor configuração.
    console.error('Falha ao iniciar a API:', err?.name);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'API indisponível: confira as variáveis de ambiente.' }));
  }
}
