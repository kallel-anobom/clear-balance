import { useMutation, useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type PreviewResponse, type PreviewRow, type TxType } from '../api';
import { Badge, Empty, ErrorBox, Field, Loading, MoneyField, Panel } from '../components';
import { TYPE_LABEL, brl, dateBR, todayISO } from '../format';
import { useLookups, useRefresh } from '../hooks';
import { extractFromFiles, isImageFile, isPdfFile, type Progress } from '../ocr';

type Row = PreviewRow & { manual?: boolean; orig?: { type: TxType; category_id: number | null }; forget?: boolean };
interface ImportBatch { id: number; label: string; source_kind: string; created_at: string; transactions: number }

const ACTIONS = { create: 'Importar', skip: 'Ignorar', link: 'Vincular ao já cadastrado' } as const;

function MappingStep({ data, onApply, busy }: { data: NonNullable<PreviewResponse['csv']>; onApply: (m: Record<string, number>) => void; busy: boolean }) {
  const [m, setM] = useState<Record<string, string>>({});
  const opt = <>{<option value="">—</option>}{data.headers.map((h, i) => <option key={i} value={i}>{h || `Coluna ${i + 1}`}</option>)}</>;
  const sel = (k: string, label: string) => (
    <Field label={label}><select value={m[k] ?? ''} onChange={(e) => setM({ ...m, [k]: e.target.value })}>{opt}</select></Field>
  );
  const ok = m.date && m.description && (m.amount || m.credit || m.debit);
  return (
    <Panel title="Indique as colunas do arquivo">
      <p className="muted">Não consegui identificar as colunas sozinho. Escolha quais colunas têm a data, a descrição e o valor.</p>
      <div className="table-scroll">
        <table className="sample"><tbody>{data.sample.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table>
      </div>
      <div className="form-grid">
        {sel('date', 'Coluna da data')}{sel('description', 'Coluna da descrição')}{sel('amount', 'Coluna do valor (com sinal)')}
        {sel('credit', 'ou coluna de crédito/entrada')}{sel('debit', 'ou coluna de débito/saída')}
      </div>
      <div className="form-actions"><button className="btn primary" disabled={!ok || busy} onClick={() => onApply(Object.fromEntries(Object.entries(m).filter(([, v]) => v !== '').map(([k, v]) => [k, Number(v)])))}>Aplicar</button></div>
    </Panel>
  );
}

export default function ImportPage({ month }: { month: string }) {
  const { accounts, cards, categories } = useLookups();
  const refresh = useRefresh();
  const fileRef = useRef<HTMLInputElement>(null);
  const [target, setTarget] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [refMonth, setRefMonth] = useState(month);
  const [invert, setInvert] = useState(false);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [invoiceDue, setInvoiceDue] = useState('');
  const [statementTotal, setStatementTotal] = useState<number | null>(null);
  const [result, setResult] = useState<{ created: number; linked: number; skipped: number } | null>(null);
  // Texto lido do arquivo (PDF/OCR): fica na tela para você corrigir e reprocessar sem refazer o OCR.
  const [readText, setReadText] = useState<{ text: string; origin: 'pdf' | 'ocr' } | null>(null);
  const [editText, setEditText] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasted, setPasted] = useState('');

  const [tType, tIdStr] = target.split(':');
  const isCard = tType === 'card';
  const file = files[0] ?? null;
  // PDF e imagens são lidos no navegador (texto/OCR); só o texto vai para a API. CSV segue por upload.
  const browserRead = files.length > 0 && files.every((f) => isPdfFile(f) || isImageFile(f));
  const isPdf = browserRead;

  const batches = useQuery({ queryKey: ['import-batches'], queryFn: () => api.get<ImportBatch[]>('/data/imports') });

  const applyPreview = (p: PreviewResponse) => {
    setPreview(p);
    setRows(p.rows.map((r) => ({ ...r, orig: { type: r.type, category_id: r.category_id } })));
    setResult(null);
    setInvoiceDue(p.pdf?.detected_due_date ?? '');
    setStatementTotal(null);
  };

  const load = useMutation({
    mutationFn: async (mapping?: Record<string, number>) => {
      if (!files.length || !target) throw new Error('Escolha a conta/cartão e o arquivo.');
      if (browserRead) {
        try {
          const { text, origin } = await extractFromFiles(files, setProgress);
          if (!text.trim()) {
            throw new Error('Não encontrei texto nos arquivos. Tente uma imagem mais nítida (print inteiro, sem cortes), cole o texto do extrato abaixo ou use o CSV do banco.');
          }
          setReadText({ text, origin });
          setEditText(text);
          setProgress({ label: 'Interpretando lançamentos', fraction: 1 });
          return await api.post<PreviewResponse>('/import/preview-text', {
            target_type: tType, target_id: Number(tIdStr), ref_month: refMonth, origin, text,
          });
        } finally {
          setProgress(null);
        }
      }
      if (files.length > 1) throw new Error('Para CSV, envie um arquivo por vez.');
      const form = new FormData();
      form.set('target_type', tType);
      form.set('target_id', tIdStr);
      if (invert) form.set('invert_sign', 'true');
      if (mapping) form.set('mapping', JSON.stringify(mapping));
      form.set('file', files[0]);
      return api.upload<PreviewResponse>('/import/preview', form);
    },
    onSuccess: (p) => applyPreview(p),
  });

  // Interpreta de novo um texto (corrigido por você ou colado), sem refazer o OCR.
  const fromText = useMutation({
    mutationFn: async (v: { text: string; origin: 'pdf' | 'ocr' }) => {
      if (!target) throw new Error('Escolha a conta ou o cartão.');
      if (!v.text.trim()) throw new Error('O texto está vazio.');
      return api.post<PreviewResponse>('/import/preview-text', {
        target_type: tType, target_id: Number(tIdStr), ref_month: refMonth, origin: v.origin, text: v.text,
      });
    },
    onSuccess: (p, v) => {
      setReadText(v);
      setEditText(v.text);
      applyPreview(p);
    },
  });

  const commit = useMutation({
    mutationFn: () => {
      const chosen = rows.filter((r) => r.action !== 'skip');
      return api.post<{ created: number; linked: number; skipped: number }>('/import/commit', {
        target_type: tType, target_id: Number(tIdStr), source_kind: preview!.source_kind,
        invoice_due_date: isCard && invoiceDue ? invoiceDue : null,
        statement_total_cents: isCard && invoiceDue ? statementTotal : null,
        rows: chosen.map((r) => ({
          date: r.date, description: r.description, abs_cents: r.abs_cents, direction: r.direction, type: isCard ? 'expense' : r.type,
          category_id: r.category_id, needs_review: r.needs_review, action: r.action, remember: corrected(r) && !r.forget,
          link_to_id: r.action === 'link' ? r.duplicate?.id ?? null : null, hash: r.hash,
          transfer_account_id: r.transfer_account_id ?? null, card_id: r.card_id ?? null,
        })),
      });
    },
    onSuccess: (res) => {
      setResult({ ...res, skipped: rows.length - res.created - res.linked });
      setPreview(null); setRows([]); setFiles([]); setReadText(null); setPasted(''); setPasteOpen(false);
      if (fileRef.current) fileRef.current.value = '';
      refresh();
    },
  });

  const del = useMutation({ mutationFn: (id: number) => api.del(`/data/imports/${id}`), onSuccess: refresh });

  // Correção do usuário em relação à sugestão: é isso que o sistema pode aprender (só nome do estabelecimento, tipo e categoria).
  const corrected = (r: Row) =>
    r.action !== 'skip' && (r.type === 'expense' || r.type === 'income' || !isCard) &&
    (r.orig ? (!isCard && r.type !== r.orig.type) || r.category_id !== r.orig.category_id : r.category_id !== null);

  const update = (idx: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.idx === idx ? { ...r, ...patch } : r)));
  const chosen = rows.filter((r) => r.action !== 'skip');
  const incomplete = chosen.filter((r) => !r.date || !r.direction || r.abs_cents <= 0 || !r.description.trim());
  const dup = rows.filter((r) => r.duplicate).length;
  const manualReview = rows.filter((r) => r.direction === null || r.uncertain_reason).length;

  const addManual = () => setRows((rs) => [...rs, {
    idx: -(rs.length + 1), date: todayISO(), description: '', abs_cents: 0, direction: isCard ? 'out' : null, type: 'expense', category_id: null,
    needs_review: true, note: 'Linha digitada manualmente', uncertain_reason: null, action: 'create', hash: null, duplicate: null, manual: true,
  }]);

  return (
    <div className="stack">
      <h1>Importação</h1>

      <div className="alert info">
        <strong>Privacidade:</strong> PDFs e imagens são lidos aqui no seu navegador (só o texto segue para a sua própria API); o arquivo <u>não é guardado</u>. Só os lançamentos que você aprovar na revisão são salvos (nunca senhas, tokens, CVV ou número completo de cartão).
        Se o PDF tiver senha, remova-a antes no seu leitor de PDF.
      </div>

      {result && (
        <div className="alert good">
          Importação concluída: <strong>{result.created}</strong> novo(s), <strong>{result.linked}</strong> vinculado(s) a itens previstos, <strong>{result.skipped}</strong> ignorado(s).{' '}
          <Link to={`/lancamentos?mes=${month}&revisar=1`}>Revisar lançamentos</Link>
        </div>
      )}

      {!preview && (
        <Panel title="1. Escolha o arquivo">
          {accounts.length + cards.length === 0 ? (
            <Empty>Antes de importar, cadastre uma conta (em <Link to="/configuracoes">Configurações</Link>) ou um cartão (em <Link to="/cartoes">Cartões e faturas</Link>).</Empty>
          ) : (
            <form className="form-grid" onSubmit={(e) => { e.preventDefault(); load.mutate(undefined); }}>
              <Field label="Este arquivo é de qual conta ou cartão?" className="span2">
                <select value={target} onChange={(e) => setTarget(e.target.value)} required>
                  <option value="">Escolha…</option>
                  {accounts.length > 0 && <optgroup label="Extrato de conta">{accounts.map((a) => <option key={a.id} value={`account:${a.id}`}>{a.name}</option>)}</optgroup>}
                  {cards.length > 0 && <optgroup label="Fatura de cartão">{cards.map((c) => <option key={c.id} value={`card:${c.id}`}>{c.name}{c.last4 ? ` •••• ${c.last4}` : ''}</option>)}</optgroup>}
                </select>
              </Field>
              <Field label="Arquivo (CSV, PDF ou imagem do extrato)" className="span2"
                hint="Imagens (PNG, JPG, WebP) e PDFs escaneados são lidos por OCR aqui no seu navegador, sem enviar a imagem a ninguém. Pode escolher várias imagens do mesmo extrato.">
                <input ref={fileRef} type="file" multiple accept=".csv,.txt,.pdf,.png,.jpg,.jpeg,.webp,text/csv,application/pdf,image/png,image/jpeg,image/webp"
                  onChange={(e) => setFiles(Array.from(e.target.files ?? []))} required />
              </Field>
              {isPdf && (
                <Field label={isCard ? 'Mês da fatura' : 'Mês do extrato'} hint="Usado para deduzir o ano das datas quando o PDF mostra só dia/mês.">
                  <input type="month" value={refMonth} onChange={(e) => setRefMonth(e.target.value)} required />
                </Field>
              )}
              {!browserRead && (
                <label className="check span2"><input type="checkbox" checked={invert} onChange={(e) => setInvert(e.target.checked)} /> Inverter os sinais (use se compras/saídas aparecerem como entradas)</label>
              )}
              <div className="span2"><ErrorBox error={load.error} /></div>
              <div className="form-actions span2"><button className="btn primary" disabled={load.isPending}>{load.isPending ? 'Lendo…' : 'Ler arquivo e revisar'}</button></div>
              {progress && (
                <div className="span2 progress" role="status">
                  <div className="small">{progress.label}… {Math.round(progress.fraction * 100)}%</div>
                  <progress value={progress.fraction} max={1} />
                </div>
              )}
            </form>
          )}
          {accounts.length + cards.length > 0 && (
            <div className="paste-box">
              {readText && load.error && (
                <p className="small">
                  O texto já foi lido, só a interpretação falhou.{' '}
                  <button type="button" className="btn small" disabled={fromText.isPending} onClick={() => fromText.mutate(readText)}>Tentar de novo sem refazer o OCR</button>
                </p>
              )}
              <button type="button" className="btn small" onClick={() => setPasteOpen((o) => !o)}>
                {pasteOpen ? 'Fechar' : 'Ou cole o texto do extrato (copiado do app ou do PDF)'}
              </button>
              {pasteOpen && (
                <div className="stack">
                  <Field label="Texto do extrato" hint="Cole as linhas como aparecem no app (data, descrição e valor). Nada é guardado; só os lançamentos que você aprovar.">
                    <textarea rows={8} value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder={'05 NOV\nMercado Central\n- R$ 120,50'} />
                  </Field>
                  {!isPdf && (
                    <Field label={isCard ? 'Mês da fatura' : 'Mês do extrato'} hint="Usado para deduzir o ano das datas.">
                      <input type="month" value={refMonth} onChange={(e) => setRefMonth(e.target.value)} required />
                    </Field>
                  )}
                  <div className="form-actions">
                    <button type="button" className="btn primary" disabled={fromText.isPending || !pasted.trim() || !target} onClick={() => fromText.mutate({ text: pasted, origin: 'pdf' })}>
                      {fromText.isPending ? 'Interpretando…' : 'Interpretar texto colado'}
                    </button>
                  </div>
                  <ErrorBox error={fromText.error} />
                </div>
              )}
            </div>
          )}
        </Panel>
      )}

      {preview?.csv?.needs_mapping && <MappingStep data={preview.csv} busy={load.isPending} onApply={(m) => load.mutate(m)} />}

      {preview && !preview.csv?.needs_mapping && (
        <Panel title="2. Revise antes de salvar" action={<button className="btn small" onClick={() => { setPreview(null); setRows([]); }}>← Escolher outro arquivo</button>}>
          {preview.pdf?.confidence === 'none' && <div className="alert bad"><strong>Revisão manual necessária.</strong> {preview.pdf.warnings.join(' ')} Você pode digitar as linhas abaixo olhando o arquivo.</div>}
          {preview.pdf?.confidence === 'low' && <div className="alert warn"><strong>{preview.source_kind === 'image' ? 'Texto lido de imagem (OCR) — confira cada linha com a imagem aberta.' : 'Leitura do PDF pouco confiável — confira cada linha com o PDF aberto.'}</strong> {' '}{preview.pdf.warnings.join(' ')} As linhas vieram desmarcadas: marque “Importar” só nas que conferir.{' '}
            <button className="btn small" onClick={() => setRows((rs) => rs.map((r) => (r.date && r.direction && r.duplicate?.level !== 'exact' ? { ...r, action: r.duplicate?.level === 'possible' && r.duplicate.status === 'scheduled' ? 'link' : 'create' } : r)))}>Já conferi: marcar todas para importar</button></div>}
          {preview.pdf?.stats && preview.pdf.confidence !== 'ok' && (
            <p className="muted small">
              Li {preview.pdf.stats.lines} linha(s) de texto: {preview.pdf.stats.lines_with_money} com valor em reais (ex.: 1.234,56)
              {preview.pdf.stats.date_headers > 0 && `, ${preview.pdf.stats.date_headers} data(s) como título de grupo`}.
              {preview.pdf.stats.lines_with_money === 0 && ' Nenhum valor reconhecido: a imagem pode estar cortada, borrada ou com a vírgula decimal ilegível.'}
            </p>
          )}
          {readText && (
            <details className="read-text" open={preview.pdf?.confidence === 'none' || rows.length === 0}>
              <summary className="small">Texto lido do arquivo — corrija e reprocesse se algo saiu errado</summary>
              <textarea rows={10} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Texto lido do arquivo" />
              <div className="form-actions">
                <button className="btn small" disabled={fromText.isPending || !editText.trim()} onClick={() => fromText.mutate({ text: editText, origin: readText.origin })}>
                  {fromText.isPending ? 'Interpretando…' : 'Reprocessar este texto'}
                </button>
                <span className="muted small">Isto substitui as linhas abaixo (as edições feitas nelas se perdem).</span>
              </div>
              <ErrorBox error={fromText.error} />
            </details>
          )}
          {preview.pdf?.confidence === 'ok' && preview.pdf.warnings.length > 0 && <div className="alert warn">{preview.pdf.warnings.join(' ')}</div>}
          {preview.pdf?.reconciliation_cents === 0 && <div className="alert good small">A soma das linhas confere com o total da fatura lido no PDF ({brl(preview.pdf.detected_total_cents)}).</div>}

          <p className="muted small">
            {rows.length} linha(s) lida(s){preview.skipped_lines > 0 && ` (${preview.skipped_lines} linha(s) de saldo/totais ignoradas)`} · {dup} possível(is) duplicata(s) · {manualReview} para conferir manualmente.
          </p>

          {isCard && (
            <div className="form-grid boxed">
              <Field label="Vencimento desta fatura" hint={preview.pdf?.detected_due_date ? 'Lido no PDF — confirme.' : 'Opcional. Em branco, as compras entram na fatura calculada pelo fechamento do cartão.'}>
                <input type="date" value={invoiceDue} onChange={(e) => setInvoiceDue(e.target.value)} />
              </Field>
              <MoneyField label="Total da fatura (opcional)" value={statementTotal} onChange={setStatementTotal}
                hint={preview.pdf?.detected_total_cents != null ? `Lido no PDF: ${brl(preview.pdf.detected_total_cents)} — digite para confirmar.` : 'Se informado, passa a ser o valor confirmado da fatura.'} />
            </div>
          )}

          <ul className="import-rows">
            {rows.map((r) => (
              <li key={r.idx} className={`import-row ${r.action === 'skip' ? 'skipped' : ''} ${r.direction === null || r.uncertain_reason ? 'uncertain' : ''}`}>
                <div className="import-top">
                  <select value={r.action} aria-label="Ação" onChange={(e) => update(r.idx, { action: e.target.value as Row['action'] })}>
                    <option value="create">{ACTIONS.create}</option>
                    <option value="skip">{ACTIONS.skip}</option>
                    {r.duplicate?.level === 'possible' && <option value="link">{ACTIONS.link}</option>}
                  </select>
                  <input type="date" value={r.date ?? ''} onChange={(e) => update(r.idx, { date: e.target.value || null })} aria-label="Data" />
                  {r.manual ? (
                    <div className="import-amount"><MoneyField label="Valor" value={r.abs_cents || null} onChange={(v) => update(r.idx, { abs_cents: v ?? 0 })} /></div>
                  ) : (
                    <strong className="import-amount">{r.direction === 'in' ? '+' : r.direction === 'out' ? '−' : ''} {brl(r.abs_cents)}</strong>
                  )}
                </div>
                <input className="import-desc" value={r.description} maxLength={200} aria-label="Descrição" placeholder="Descrição" onChange={(e) => update(r.idx, { description: e.target.value })} />
                <div className="import-opts">
                  {r.direction === null || r.manual ? (
                    <select value={r.direction ?? ''} aria-label="Entrada ou saída" onChange={(e) => update(r.idx, { direction: (e.target.value || null) as Row['direction'] })}>
                      <option value="">Entrada ou saída?</option><option value="in">Entrada</option><option value="out">Saída</option>
                    </select>
                  ) : <Badge tone={r.direction === 'in' ? 'good' : 'neutral'}>{r.direction === 'in' ? 'Entrada' : 'Saída'}</Badge>}
                  {!isCard && (
                    <select value={r.type} aria-label="Tipo" onChange={(e) => update(r.idx, { type: e.target.value as TxType })}>
                      {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                    </select>
                  )}
                  {(r.type === 'expense' || r.type === 'income') && (
                    <select value={r.category_id ?? ''} aria-label="Categoria" onChange={(e) => update(r.idx, { category_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Sem categoria</option>
                      {categories.filter((c) => c.kind === (r.type === 'income' ? 'income' : 'expense')).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                  {!isCard && r.type === 'transfer' && (
                    <select value={r.transfer_account_id ?? ''} aria-label="Outra conta" onChange={(e) => update(r.idx, { transfer_account_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">{r.direction === 'in' ? 'Veio de qual conta?' : 'Foi para qual conta?'}</option>
                      {accounts.filter((a) => `account:${a.id}` !== target).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  )}
                  {!isCard && r.type === 'invoice_payment' && (
                    <select value={r.card_id ?? ''} aria-label="Cartão pago" onChange={(e) => update(r.idx, { card_id: e.target.value ? Number(e.target.value) : null })}>
                      <option value="">Qual cartão?</option>{cards.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  )}
                  <label className="check"><input type="checkbox" checked={r.needs_review} onChange={(e) => update(r.idx, { needs_review: e.target.checked })} /> revisar depois</label>
                  {corrected(r) && (
                    <label className="check" title="Guarda só o nome do estabelecimento e a classificação (sem valores nem datas).">
                      <input type="checkbox" checked={!r.forget} onChange={(e) => update(r.idx, { forget: !e.target.checked })} /> lembrar esta correção
                    </label>
                  )}
                </div>
                <div className="import-notes">
                  {r.learned && <Badge tone="info" title="Classificação lembrada de correções anteriores. Gerencie em Configurações › Regras aprendidas.">aprendida ({r.learned.uses}×)</Badge>}
                  {r.installment && <Badge tone="info" title="Compra parcelada">parcela {r.installment.no}/{r.installment.total}</Badge>}
                  {r.uncertain_reason && <Badge tone="warn">conferir: {r.uncertain_reason}</Badge>}
                  {r.duplicate?.level === 'exact' && <Badge tone="bad">duplicata exata</Badge>}
                  {r.duplicate?.level === 'possible' && <Badge tone="warn">possível duplicata de “{r.duplicate.description}” ({dateBR(r.duplicate.date)}, {r.duplicate.status === 'scheduled' ? 'previsto' : 'já pago'})</Badge>}
                  {r.note && <span className="muted small">{r.note}</span>}
                </div>
              </li>
            ))}
          </ul>

          <div className="form-actions between">
            <button className="btn" onClick={addManual}>+ Adicionar linha manualmente</button>
            <div>
              {incomplete.length > 0 && <span className="muted small">Complete data, descrição, valor e entrada/saída em {incomplete.length} linha(s). </span>}
              <button className="btn primary" disabled={commit.isPending || chosen.length === 0 || incomplete.length > 0} onClick={() => commit.mutate()}>
                {commit.isPending ? 'Salvando…' : `Salvar ${chosen.length} lançamento(s)`}
              </button>
            </div>
          </div>
          <ErrorBox error={commit.error} />
        </Panel>
      )}

      <Panel title="Importações anteriores">
        {batches.isLoading ? <Loading /> : (batches.data ?? []).length === 0 ? <Empty>Nenhuma importação salva.</Empty> : (
          <ul className="rows">
            {batches.data!.map((b) => (
              <li className="row" key={b.id}>
                <div className="row-main"><strong>{b.label}</strong><div className="row-sub">{b.transactions} lançamento(s) criado(s)</div></div>
                <button className="btn small danger" onClick={() => confirm(`Apagar esta importação e os ${b.transactions} lançamentos que ela criou?`) && del.mutate(b.id)}>Apagar importação</button>
              </li>
            ))}
          </ul>
        )}
        <ErrorBox error={del.error} />
      </Panel>
    </div>
  );
}
