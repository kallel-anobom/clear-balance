import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { FastifyInstance } from 'fastify';
import { HttpError } from './errors.js';

type StaticKey = Parameters<typeof jwtVerify>[1] extends infer K ? Exclude<K, (...a: any[]) => any> : never;

export interface AuthConfig {
  /** Desligado só em desenvolvimento local e testes. Nunca aceito em produção. */
  disabled: boolean;
  /** Emissor esperado do token, p. ex. https://xxxx.supabase.co/auth/v1 */
  issuer?: string;
  /** Chave de verificação: função JWKS (padrão) ou chave estática. */
  key?: JWTVerifyGetKey | StaticKey;
  algorithms?: string[];
  /** E-mails autorizados (minúsculos). Conta única: normalmente só o seu. */
  allowedEmails: string[];
  /** Exige 2FA (nível aal2) no token. */
  requireMfa: boolean;
}

export interface AuthUser {
  id: string;
  email: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

/** Lê a configuração de autenticação das variáveis de ambiente e recusa combinações inseguras. */
export function resolveAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const production = env.NODE_ENV === 'production' || Boolean(env.VERCEL);
  const disabled = env.AUTH_DISABLED === 'true';
  if (disabled && production) {
    throw new Error('AUTH_DISABLED=true não é permitido em produção. Remova essa variável.');
  }
  const allowedEmails = (env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const requireMfa = env.REQUIRE_MFA === 'true';
  if (disabled) return { disabled: true, allowedEmails, requireMfa: false };

  const supabaseUrl = (env.SUPABASE_URL ?? '').replace(/\/+$/, '');
  if (!supabaseUrl) throw new Error('Defina SUPABASE_URL (ou AUTH_DISABLED=true somente em desenvolvimento local).');
  if (!allowedEmails.length) throw new Error('Defina ALLOWED_EMAILS com o e-mail autorizado a entrar.');
  const issuer = `${supabaseUrl}/auth/v1`;
  if (env.SUPABASE_JWT_SECRET) {
    // Projetos antigos do Supabase assinam com segredo compartilhado (HS256).
    return {
      disabled: false, issuer, allowedEmails, requireMfa,
      key: new TextEncoder().encode(env.SUPABASE_JWT_SECRET), algorithms: ['HS256'],
    };
  }
  return {
    disabled: false, issuer, allowedEmails, requireMfa,
    key: createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`)),
    algorithms: ['ES256', 'RS256', 'EdDSA'],
  };
}

/** Valida o token de acesso do Supabase e a lista de e-mails autorizados. Lança HttpError 401/403. */
export async function verifyAccessToken(token: string, cfg: AuthConfig): Promise<AuthUser> {
  if (!cfg.key || !cfg.issuer) throw new HttpError(401, 'Autenticação não configurada.');
  let payload: Record<string, unknown>;
  try {
    const opts = { issuer: cfg.issuer, audience: 'authenticated', algorithms: cfg.algorithms };
    const res =
      typeof cfg.key === 'function'
        ? await jwtVerify(token, cfg.key, opts)
        : await jwtVerify(token, cfg.key as StaticKey as never, opts);
    payload = res.payload as Record<string, unknown>;
  } catch {
    throw new HttpError(401, 'Sessão inválida ou expirada. Entre novamente.');
  }
  const email = typeof payload.email === 'string' ? payload.email.toLowerCase() : '';
  const id = typeof payload.sub === 'string' ? payload.sub : '';
  if (!email || !id) throw new HttpError(401, 'Sessão inválida.');
  if (!cfg.allowedEmails.includes(email)) throw new HttpError(403, 'Este e-mail não tem acesso ao sistema.');
  if (cfg.requireMfa && payload.aal !== 'aal2') throw new HttpError(403, 'Ative e confirme a verificação em duas etapas.');
  return { id, email };
}

/** Exige login em todas as rotas do escopo, exceto /health. */
export function requireAuth(app: FastifyInstance, cfg: AuthConfig) {
  app.addHook('onRequest', async (req) => {
    if (cfg.disabled) return;
    if (req.method === 'OPTIONS') return;
    if (req.url.split('?')[0].endsWith('/health')) return;
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) throw new HttpError(401, 'Faça login para continuar.');
    req.user = await verifyAccessToken(header.slice(7).trim(), cfg);
  });
}
