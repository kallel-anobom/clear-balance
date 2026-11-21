import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, qs, type CheckItem, type ChecksResponse } from './api';
import { Badge, ErrorBox, Loading, Panel } from './components';
import { monthLabel } from './format';

const LEVEL: Record<CheckItem['level'], { tone: 'bad' | 'warn' | 'info'; label: string }> = {
  bad: { tone: 'bad', label: 'Corrigir' },
  warn: { tone: 'warn', label: 'Conferir' },
  info: { tone: 'info', label: 'Atenção' },
};

/** Conferência dos números do mês: o que pode estar errado, sem IA (checagens calculadas no servidor). */
export function ChecksPanel({ month }: { month: string }) {
  const q = useQuery({ queryKey: ['checks', month], queryFn: () => api.get<ChecksResponse>(`/overview/checks${qs({ month })}`) });
  const title = `Conferência dos números de ${monthLabel(month)}`;
  if (q.isLoading) return <Panel title={title}><Loading /></Panel>;
  if (q.error || !q.data) return <Panel title={title}><ErrorBox error={q.error ?? new Error('Sem dados')} /></Panel>;

  const { checks, total, passed, certain_pct } = q.data;
  const serious = checks.filter((c) => c.level !== 'info').length;
  return (
    <Panel
      title={title}
      action={<span className="muted small">{passed} de {total} verificações sem alerta{certain_pct !== null ? ` · ${certain_pct}% da saída prevista já lançada` : ''}</span>}
    >
      {checks.length === 0 ? (
        <div className="alert good">Tudo certo: nenhuma divergência encontrada nos valores deste mês.</div>
      ) : (
        <>
          {serious === 0 && <p className="muted small">Nenhuma divergência grave. Só pontos de atenção:</p>}
          {checks.map((c) => (
            <div key={c.code + c.title} className="row">
              <div className="row-main">
                <div><Badge tone={LEVEL[c.level].tone}>{LEVEL[c.level].label}</Badge> <strong>{c.title}</strong></div>
                <div className="row-sub">{c.detail}</div>
              </div>
              {c.action && <Link className="btn small" to={c.action.to}>{c.action.label}</Link>}
            </div>
          ))}
        </>
      )}
      <p className="muted small">
        São checagens automáticas, sem IA, feitas com os dados que o sistema já tem. Elas apontam onde olhar; quem confirma o valor certo é a fatura do banco.
      </p>
    </Panel>
  );
}
