import { useEffect, useState, type ReactNode } from 'react';
import { centsToInput, parseMoneyInput } from './format';

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Fechar">✕</button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className ?? ''}`}>
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

/** Campo de valor em reais. Guarda texto digitado e devolve centavos (null se vazio). */
export function MoneyField({
  label, value, onChange, hint, required, className, allowNegative,
}: {
  label: string; value: number | null; onChange: (cents: number | null) => void; hint?: string;
  required?: boolean; className?: string; allowNegative?: boolean;
}) {
  const [text, setText] = useState(centsToInput(value));
  const [lastValue, setLastValue] = useState(value);
  // Sincroniza quando o valor muda por fora (ex.: cálculo automático).
  if (value !== lastValue && parseMoneyInput(text) !== value) {
    setLastValue(value);
    setText(centsToInput(value));
  }
  const invalid = text.trim() !== '' && parseMoneyInput(text) === null;
  return (
    <Field label={label} hint={invalid ? 'Valor inválido. Exemplo: 1.234,56' : hint} className={className}>
      <div className={`money-input ${invalid ? 'invalid' : ''}`}>
        <span>R$</span>
        <input
          inputMode="decimal"
          value={text}
          required={required}
          placeholder="0,00"
          onChange={(e) => {
            setText(e.target.value);
            const v = parseMoneyInput(e.target.value);
            const ok = v !== null && (allowNegative || v >= 0);
            setLastValue(ok ? v : null);
            onChange(ok ? v : null);
          }}
          onBlur={() => value !== null && setText(centsToInput(value))}
        />
      </div>
    </Field>
  );
}

type Tone = 'neutral' | 'warn' | 'good' | 'bad' | 'info';
export function Badge({ children, tone = 'neutral', title }: { children: ReactNode; tone?: Tone; title?: string }) {
  return <span className={`badge ${tone}`} title={title}>{children}</span>;
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="alert bad" role="alert">{(error as Error).message}</div>;
}

export function Loading() {
  return <div className="muted pad">Carregando…</div>;
}

export function Panel({ title, children, action, className }: { title?: ReactNode; children: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <section className={`card ${className ?? ''}`}>
      {(title || action) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {action}
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="muted empty">{children}</p>;
}
