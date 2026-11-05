import { SignJWT, generateKeyPair } from 'jose';
import { describe, expect, it } from 'vitest';
import { resolveAuthConfig, verifyAccessToken, type AuthConfig } from '../src/auth.js';

const ISSUER = 'https://proj.supabase.co/auth/v1';

async function setup(overrides: Partial<AuthConfig> = {}) {
  const { publicKey, privateKey } = await generateKeyPair('ES256');
  const cfg: AuthConfig = {
    disabled: false, issuer: ISSUER, key: publicKey, algorithms: ['ES256'],
    allowedEmails: ['eu@exemplo.com'], requireMfa: false, ...overrides,
  };
  const sign = (claims: Record<string, unknown> = {}, o: { exp?: string; iss?: string; aud?: string; key?: CryptoKey } = {}) =>
    new SignJWT({ email: 'eu@exemplo.com', ...claims })
      .setProtectedHeader({ alg: 'ES256' })
      .setSubject('user-1')
      .setIssuer(o.iss ?? ISSUER)
      .setAudience(o.aud ?? 'authenticated')
      .setIssuedAt()
      .setExpirationTime(o.exp ?? '1h')
      .sign(o.key ?? privateKey);
  return { cfg, sign, privateKey, publicKey };
}

describe('verifyAccessToken', () => {
  it('aceita token válido de e-mail autorizado (sem diferenciar maiúsculas)', async () => {
    const { cfg, sign } = await setup();
    const user = await verifyAccessToken(await sign({ email: 'EU@Exemplo.com' }), cfg);
    expect(user).toEqual({ id: 'user-1', email: 'eu@exemplo.com' });
  });

  it('recusa token expirado', async () => {
    const { cfg, sign } = await setup();
    await expect(verifyAccessToken(await sign({}, { exp: '-1m' }), cfg)).rejects.toMatchObject({ status: 401 });
  });

  it('recusa emissor ou audiência errados', async () => {
    const { cfg, sign } = await setup();
    await expect(verifyAccessToken(await sign({}, { iss: 'https://outro.supabase.co/auth/v1' }), cfg)).rejects.toMatchObject({ status: 401 });
    await expect(verifyAccessToken(await sign({}, { aud: 'anon' }), cfg)).rejects.toMatchObject({ status: 401 });
  });

  it('recusa token assinado por outra chave', async () => {
    const { cfg, sign } = await setup();
    const other = await generateKeyPair('ES256');
    await expect(verifyAccessToken(await sign({}, { key: other.privateKey }), cfg)).rejects.toMatchObject({ status: 401 });
  });

  it('recusa lixo no lugar do token', async () => {
    const { cfg } = await setup();
    await expect(verifyAccessToken('abc.def.ghi', cfg)).rejects.toMatchObject({ status: 401 });
  });

  it('recusa e-mail fora da lista com 403', async () => {
    const { cfg, sign } = await setup();
    await expect(verifyAccessToken(await sign({ email: 'intruso@exemplo.com' }), cfg)).rejects.toMatchObject({ status: 403 });
  });

  it('exige 2FA (aal2) quando REQUIRE_MFA está ligado', async () => {
    const { cfg, sign } = await setup({ requireMfa: true });
    await expect(verifyAccessToken(await sign({ aal: 'aal1' }), cfg)).rejects.toMatchObject({ status: 403 });
    await expect(verifyAccessToken(await sign({ aal: 'aal2' }), cfg)).resolves.toMatchObject({ email: 'eu@exemplo.com' });
  });
});

describe('resolveAuthConfig', () => {
  it('recusa AUTH_DISABLED em produção', () => {
    expect(() => resolveAuthConfig({ NODE_ENV: 'production', AUTH_DISABLED: 'true' })).toThrow(/produção/);
    expect(() => resolveAuthConfig({ VERCEL: '1', AUTH_DISABLED: 'true' })).toThrow(/produção/);
  });

  it('permite AUTH_DISABLED fora de produção', () => {
    expect(resolveAuthConfig({ AUTH_DISABLED: 'true' }).disabled).toBe(true);
  });

  it('exige SUPABASE_URL e ALLOWED_EMAILS quando o login está ligado', () => {
    expect(() => resolveAuthConfig({})).toThrow(/SUPABASE_URL/);
    expect(() => resolveAuthConfig({ SUPABASE_URL: 'https://p.supabase.co' })).toThrow(/ALLOWED_EMAILS/);
    const cfg = resolveAuthConfig({ SUPABASE_URL: 'https://p.supabase.co/', ALLOWED_EMAILS: ' A@x.com , b@x.com ', REQUIRE_MFA: 'true' });
    expect(cfg.issuer).toBe('https://p.supabase.co/auth/v1');
    expect(cfg.allowedEmails).toEqual(['a@x.com', 'b@x.com']);
    expect(cfg.requireMfa).toBe(true);
  });
});
