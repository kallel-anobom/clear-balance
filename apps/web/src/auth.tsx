import { useQueryClient } from '@tanstack/react-query';
import type { Session } from '@supabase/supabase-js';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ErrorBox, Field, Loading } from './components';
import { authEnabled, supabase } from './supabase';

interface AuthInfo {
  enabled: boolean;
  email: string | null;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<AuthInfo>({ enabled: false, email: null, signOut: async () => {} });
export const useAuth = () => useContext(AuthContext);

function LoginScreen({ onDone, mfaOnly }: { onDone: () => void; mfaOnly?: boolean }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [factorId, setFactorId] = useState<string | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  // Sessão já existe, mas falta o segundo fator (ex.: página recarregada): pede só o código.
  useEffect(() => {
    if (!mfaOnly || !supabase) return;
    supabase.auth.mfa.listFactors().then(({ data }) => {
      const totp = data?.totp?.[0];
      if (totp) setFactorId(totp.id);
    });
  }, [mfaOnly]);

  async function submitPassword(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    if (err) {
      // Mensagem genérica: não revela se o e-mail existe.
      setError(new Error('E-mail ou senha incorretos.'));
      setBusy(false);
      return;
    }
    setBusy(false);
    onDone();
  }

  async function submitCode(e: React.FormEvent) {
    e.preventDefault();
    if (!supabase || !factorId) return;
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.auth.mfa.challengeAndVerify({ factorId, code: code.trim() });
    setBusy(false);
    if (err) return setError(new Error('Código inválido ou expirado.'));
    onDone();
  }

  async function cancelMfa() {
    await supabase?.auth.signOut();
    setFactorId(null);
    setCode('');
    setPassword('');
    onDone();
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={factorId ? submitCode : submitPassword}>
        <div className="brand">💰 Clear Balance</div>
        {factorId ? (
          <>
            <p className="muted small">Digite o código de 6 dígitos do seu aplicativo autenticador.</p>
            <Field label="Código">
              <input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required autoFocus />
            </Field>
          </>
        ) : (
          <>
            <p className="muted small">Entre para ver seus dados financeiros.</p>
            <Field label="E-mail">
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
            </Field>
            <Field label="Senha">
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            </Field>
          </>
        )}
        <ErrorBox error={error} />
        <button className="btn primary" disabled={busy}>{busy ? 'Entrando…' : factorId ? 'Confirmar' : 'Entrar'}</button>
        {factorId && <button type="button" className="btn" onClick={cancelMfa}>Voltar</button>}
      </form>
    </div>
  );
}

/** Mostra a tela de login até existir uma sessão válida (e 2FA, se ativado). No modo local libera direto. */
export function AuthGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<Session | null>(null);
  const [needsMfa, setNeedsMfa] = useState(false);
  const [loading, setLoading] = useState(authEnabled);

  async function refresh() {
    if (!supabase) return;
    const { data } = await supabase.auth.getSession();
    setSession(data.session);
    if (data.session) {
      const aal = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
      setNeedsMfa(aal.data?.nextLevel === 'aal2' && aal.data.currentLevel !== 'aal2');
    } else {
      setNeedsMfa(false);
    }
    setLoading(false);
  }

  useEffect(() => {
    if (!supabase) return;
    refresh();
    const { data } = supabase.auth.onAuthStateChange((_event, s) => {
      // Ao sair, descarta dados em cache para não deixar valores na tela/memória.
      if (!s) queryClient.clear();
      setTimeout(refresh, 0);
    });
    return () => data.subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient]);

  if (!authEnabled) return <>{children}</>;
  if (loading) return <Loading />;
  if (!session) return <LoginScreen onDone={refresh} />;
  if (needsMfa) return <LoginScreen onDone={refresh} mfaOnly />;
  return (
    <AuthContext.Provider
      value={{ enabled: true, email: session.user.email ?? null, signOut: async () => { await supabase?.auth.signOut(); } }}
    >
      {children}
    </AuthContext.Provider>
  );
}
