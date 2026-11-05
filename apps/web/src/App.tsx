import { useQuery } from '@tanstack/react-query';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api } from './api';
import { useAuth } from './auth';
import { Loading } from './components';
import { addMonths, monthLabel } from './format';
import { useMonth } from './hooks';
import CardsPage from './pages/Cards';
import ImportPage from './pages/Import';
import OverviewPage from './pages/Overview';
import SettingsPage from './pages/Settings';
import TransactionsPage from './pages/Transactions';

const NAV = [
  { to: '/', label: 'Visão do mês', icon: '📊', end: true },
  { to: '/lancamentos', label: 'Lançamentos', icon: '🧾' },
  { to: '/cartoes', label: 'Cartões e faturas', icon: '💳' },
  { to: '/importar', label: 'Importação', icon: '📥' },
  { to: '/configuracoes', label: 'Configurações', icon: '⚙️' },
];

export default function App() {
  const auth = useAuth();
  const [month, setMonth] = useMonth();
  const location = useLocation();
  const search = location.search;
  const showMonth = location.pathname !== '/configuracoes';

  // Gera os lançamentos previstos das recorrências do mês (idempotente) antes de exibir os dados.
  const ensure = useQuery({
    queryKey: ['ensure', month],
    queryFn: () => api.post<{ created: number }>(`/months/${month}/ensure`),
    staleTime: Infinity,
  });
  const health = useQuery({ queryKey: ['health'], queryFn: () => api.get('/health'), retry: 1, refetchInterval: 15_000 });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">💰 Clear Balance</div>
        <nav>
          {NAV.map((n) => (
            <NavLink key={n.to} to={{ pathname: n.to, search }} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
              <span aria-hidden>{n.icon}</span> {n.label}
            </NavLink>
          ))}
        </nav>
        {auth.enabled ? (
          <div className="side-note small">
            <div className="muted" title={auth.email ?? ''}>{auth.email}</div>
            <button className="btn small" onClick={() => auth.signOut()}>Sair</button>
          </div>
        ) : (
          <p className="muted small side-note">Modo local: seus dados ficam só neste computador.</p>
        )}
      </aside>

      <main>
        <header className="topbar">
          <div className="brand mobile-only">💰 Clear Balance</div>
          {showMonth && (
            <div className="month-nav" role="group" aria-label="Mês">
              <button onClick={() => setMonth(addMonths(month, -1))} aria-label="Mês anterior">‹</button>
              <label className="month-label">
                <span className="month-text">{monthLabel(month)}</span>
                <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} aria-label="Escolher mês" />
              </label>
              <button onClick={() => setMonth(addMonths(month, 1))} aria-label="Próximo mês">›</button>
            </div>
          )}
          {auth.enabled && <button className="btn small mobile-only" onClick={() => auth.signOut()}>Sair</button>}
        </header>

        {health.isError && (
          <div className="alert bad">
            Não consegui falar com a API. Confira se o sistema está rodando (<code>npm run dev</code>) e se o banco está no ar (<code>npm run db:up</code>).
          </div>
        )}
        <div className="content">
          {ensure.isPending ? (
            <Loading />
          ) : (
            <Routes>
              <Route path="/" element={<OverviewPage month={month} />} />
              <Route path="/lancamentos" element={<TransactionsPage month={month} />} />
              <Route path="/cartoes" element={<CardsPage month={month} />} />
              <Route path="/importar" element={<ImportPage month={month} />} />
              <Route path="/configuracoes" element={<SettingsPage />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
          )}
        </div>
      </main>

      <nav className="bottom-nav" aria-label="Navegação">
        {NAV.map((n) => (
          <NavLink key={n.to} to={{ pathname: n.to, search }} end={n.end} className={({ isActive }) => (isActive ? 'active' : '')}>
            <span aria-hidden>{n.icon}</span>
            <small>{n.label.split(' ')[0]}</small>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
