import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type Tx } from './api';
import { ErrorBox, Field, Modal, MoneyField } from './components';
import { todayISO } from './format';
import { useRefresh } from './hooks';

/** Confirma que um item previsto foi pago/recebido, com a data e o valor reais. */
export function MarkPaid({ txId, label, amount, income, onClose }: { txId: number; label: string; amount: number; income?: boolean; onClose: () => void }) {
  const refresh = useRefresh();
  const [date, setDate] = useState(todayISO());
  const [value, setValue] = useState<number | null>(amount);
  const save = useMutation({
    mutationFn: async () => {
      if (value === null) throw new Error('Informe o valor.');
      const tx = await api.get<Tx>(`/transactions/${txId}`);
      const patch: Record<string, unknown> = {
        status: 'paid', paid_on: date, occurred_on: tx.occurred_on ?? date, date_confirmed: true,
      };
      if (value !== tx.total_cents) {
        // O valor real foi confirmado: deixa de ser estimativa.
        patch.is_estimate = false;
        if (tx.type === 'income' && tx.gross_cents !== null) patch.deductions_cents = tx.gross_cents - value;
        else {
          patch.total_cents = value;
          if (tx.type === 'expense' && (tx.my_share_cents === null || tx.my_share_cents === tx.total_cents)) patch.my_share_cents = value;
        }
      }
      return api.patch(`/transactions/${txId}`, patch);
    },
    onSuccess: () => { refresh(); onClose(); },
  });
  return (
    <Modal title={income ? 'Marcar como recebido' : 'Marcar como pago'} onClose={onClose}>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
        <p className="span2"><strong>{label}</strong></p>
        <Field label={income ? 'Data em que recebi' : 'Data em que paguei'}>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </Field>
        <MoneyField label={income ? 'Valor líquido recebido' : 'Valor pago'} value={value} onChange={setValue} required
          hint="Se o valor real for diferente do previsto, corrija aqui." />
        <div className="span2"><ErrorBox error={save.error} /></div>
        <div className="form-actions span2">
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={save.isPending}>Confirmar</button>
        </div>
      </form>
    </Modal>
  );
}
