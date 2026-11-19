import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type Tx } from '../api';
import { Empty, ErrorBox, Field, Loading, MoneyField, Panel } from '../components';
import { brl, dateBR, todayISO } from '../format';
import { useLookups, useRefresh } from '../hooks';

const LAST_CARD = 'cb:quick:card';

function rememberedCard(): string {
  try { return localStorage.getItem(LAST_CARD) ?? ''; } catch { return ''; }
}

/** Lançamento rápido de uma compra no cartão (pensado para o celular, na hora da compra). */
export default function QuickAddPage() {
  const { cards, loading } = useLookups();
  const refresh = useRefresh();
  const [cardId, setCardId] = useState(rememberedCard());
  const [cents, setCents] = useState<number | null>(null);
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());
  const [added, setAdded] = useState<Tx[]>([]);

  // Cartão lembrado que foi apagado: cai no primeiro da lista.
  const effectiveCard = cards.some((c) => String(c.id) === cardId) ? cardId : cards[0] ? String(cards[0].id) : '';

  const save = useMutation({
    mutationFn: () =>
      api.post<Tx>('/transactions', {
        type: 'expense',
        description: description.trim(),
        card_id: Number(effectiveCard),
        occurred_on: date,
        total_cents: cents,
        // Sem categoria: fica na lista "para revisar" e a categoria é escolhida depois em Lançamentos (que aprende).
        needs_review: true,
        review_note: 'Lançamento rápido: confira a categoria.',
      }),
    onSuccess: (tx) => {
      try { localStorage.setItem(LAST_CARD, effectiveCard); } catch { /* sem armazenamento: tudo bem */ }
      setAdded((list) => [tx, ...list].slice(0, 5));
      setCents(null);
      setDescription('');
      setDate(todayISO());
      refresh();
    },
  });

  if (loading) return <Loading />;

  if (cards.length === 0) {
    return (
      <Panel title="Lançar compra no cartão">
        <Empty>Cadastre um cartão em <Link to="/cartoes">Cartões e faturas</Link> para lançar compras por aqui.</Empty>
      </Panel>
    );
  }

  const ready = cents !== null && cents > 0 && description.trim() !== '' && !!effectiveCard;

  return (
    <>
      <Panel title="Lançar compra no cartão">
        <form
          className="form-grid"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) save.mutate();
          }}
        >
          <Field label="Cartão">
            <select value={effectiveCard} onChange={(e) => setCardId(e.target.value)}>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` (final ${c.last4})` : ''}</option>
              ))}
            </select>
          </Field>
          <MoneyField label="Valor" value={cents} onChange={setCents} required />
          <Field label="Onde foi">
            <input value={description} maxLength={200} required placeholder="Ex.: Mercado" onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <Field label="Data da compra">
            <input type="date" value={date} required onChange={(e) => setDate(e.target.value)} />
          </Field>
          <div className="span2">
            <button className="btn primary" type="submit" disabled={!ready || save.isPending}>
              {save.isPending ? 'Salvando…' : 'Lançar compra'}
            </button>
          </div>
          <div className="span2"><ErrorBox error={save.error} /></div>
        </form>
        <p className="muted small">
          A compra entra na fatura certa pela data e já aparece na previsão. A categoria fica para revisar em <Link to="/lancamentos">Lançamentos</Link>.
          Ao importar a fatura depois, a importação avisa as compras que parecem repetidas (mesma data e valor) para você vincular em vez de duplicar.
        </p>
      </Panel>

      {added.length > 0 && (
        <Panel title="Lançadas agora">
          {added.map((t) => (
            <div key={t.id} className="row">
              <div className="row-main">
                <div>{t.description}</div>
                <div className="row-sub">{t.card_name} · {dateBR(t.occurred_on)}</div>
              </div>
              <strong>{brl(t.total_cents)}</strong>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}
