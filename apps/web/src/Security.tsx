import { useEffect, useState } from 'react';
import { useAuth } from './auth';
import { ErrorBox, Field, Panel } from './components';
import { supabase } from './supabase';

interface Enrollment { factorId: string; qr: string; secret: string }

/** Verificação em duas etapas (TOTP) pelo Supabase Auth. Só aparece quando o login está ativo. */
export default function SecurityPanel() {
  const auth = useAuth();
  const [verifiedFactor, setVerifiedFactor] = useState<string | null>(null);
  const [enroll, setEnroll] = useState<Enrollment | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    if (!supabase) return;
    const { data } = await supabase.auth.mfa.listFactors();
    setVerifiedFactor(data?.totp?.find((f) => f.status === 'verified')?.id ?? null);
  }
  useEffect(() => { load(); }, []);

  if (!auth.enabled || !supabase) return null;
  const client = supabase;

  async function start() {
    setBusy(true);
    setError(null);
    // Remove tentativas antigas não confirmadas, para não acumular fatores.
    const { data: list } = await client.auth.mfa.listFactors();
    for (const f of list?.all ?? []) if (f.factor_type === 'totp' && f.status === 'unverified') await client.auth.mfa.unenroll({ factorId: f.id });
    const { data, error: err } = await client.auth.mfa.enroll({ factorType: 'totp', friendlyName: `Clear Balance ${new Date().toISOString().slice(0, 10)}` });
    setBusy(false);
    if (err || !data) return setError(new Error('Não foi possível iniciar a verificação em duas etapas.'));
    setEnroll({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret });
  }

  async function confirm_() {
    if (!enroll) return;
    setBusy(true);
    setError(null);
    const { error: err } = await client.auth.mfa.challengeAndVerify({ factorId: enroll.factorId, code: code.trim() });
    setBusy(false);
    if (err) return setError(new Error('Código inválido. Confira o aplicativo e tente de novo.'));
    setEnroll(null);
    setCode('');
    await load();
  }

  async function disable() {
    if (!verifiedFactor || !window.confirm('Desativar a verificação em duas etapas?')) return;
    setBusy(true);
    const { error: err } = await client.auth.mfa.unenroll({ factorId: verifiedFactor });
    setBusy(false);
    if (err) return setError(new Error('Não foi possível desativar (confirme o código ao entrar e tente novamente).'));
    await load();
  }

  return (
    <Panel title="Conta e segurança">
      <p className="small">Você entrou como <strong>{auth.email}</strong>.</p>
      {verifiedFactor ? (
        <>
          <p className="small">✅ Verificação em duas etapas <strong>ativa</strong>.</p>
          <button className="btn danger small" onClick={disable} disabled={busy}>Desativar</button>
        </>
      ) : enroll ? (
        <div className="stack">
          <p className="small">Leia o QR code com um aplicativo autenticador (Google Authenticator, Authy, 1Password…) e digite o código de 6 dígitos.</p>
          <div className="qr-box">
            <img src={enroll.qr} alt="QR code para o aplicativo autenticador" />
            <div className="small">Ou digite a chave manualmente:<div className="secret"><code>{enroll.secret}</code></div></div>
          </div>
          <Field label="Código de 6 dígitos"><input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" maxLength={6} /></Field>
          <div className="tx-actions">
            <button className="btn primary" onClick={confirm_} disabled={busy || code.trim().length !== 6}>Ativar</button>
            <button className="btn" onClick={() => setEnroll(null)}>Cancelar</button>
          </div>
        </div>
      ) : (
        <>
          <p className="muted small">Recomendado: pede um código do celular além da senha.</p>
          <button className="btn primary small" onClick={start} disabled={busy}>Ativar verificação em duas etapas</button>
        </>
      )}
      <ErrorBox error={error} />
    </Panel>
  );
}
