import type { Queryable } from '../db.js';
import { categoryFromRules, merchantKey, type LearnedRule } from '../importer/classify.js';
import type { TargetKind } from '../importer/types.js';

/** Grava (ou reforça) a regra do estabelecimento. Só guarda o nome normalizado, a categoria e o tipo. */
export async function rememberRule(
  db: Queryable,
  kind: TargetKind,
  row: { description: string; type: string; category_id: number | null },
) {
  const pattern = merchantKey(row.description);
  if (!pattern) return false;
  const categoryId = ['expense', 'income'].includes(row.type) ? row.category_id : null;
  await db.query(
    `insert into learned_rules (kind, pattern, category_id, type) values ($1, $2, $3, $4)
     on conflict (kind, pattern) do update
       set category_id = excluded.category_id, type = excluded.type,
           use_count = learned_rules.use_count + 1, last_used_at = now()`,
    [kind, pattern, categoryId, row.type],
  );
  return true;
}

export interface ApplyPreviewItem { id: number; description: string; category_name: string; via: 'exact' | 'similar'; pattern: string }
export interface ApplyResult { dry_run: boolean; total_uncategorized: number; matched: number; updated: number; sample: ApplyPreviewItem[] }

/**
 * Aplica as regras aprendidas aos lançamentos antigos SEM categoria. Nunca altera lançamento que já tem
 * categoria (inclusive as que você corrigiu) e não marca o lançamento como "editado à mão".
 */
export async function applyRulesToUncategorized(db: Queryable, opts: { dry_run: boolean }): Promise<ApplyResult> {
  const [rulesRes, catsRes, txRes] = await Promise.all([
    db.query('select id, kind, pattern, category_id, type, ignore, use_count from learned_rules where category_id is not null'),
    db.query('select id, name, kind from categories'),
    db.query(
      `select id, description, type, card_id from transactions
       where category_id is null and type in ('expense', 'income') order by id`,
    ),
  ]);
  const rules: LearnedRule[] = rulesRes.rows;
  const cats = new Map<number, { name: string; kind: string }>(catsRes.rows.map((c) => [c.id, c]));
  const matches: (ApplyPreviewItem & { category_id: number })[] = [];
  for (const t of txRes.rows) {
    const m = categoryFromRules(t.description, t.card_id ? 'card' : 'account', rules);
    const cat = m && cats.get(m.category_id);
    // A categoria precisa combinar com o tipo (despesa x receita).
    if (!m || !cat || cat.kind !== (t.type === 'income' ? 'income' : 'expense')) continue;
    matches.push({ id: t.id, description: t.description, category_name: cat.name, via: m.via, pattern: m.pattern, category_id: m.category_id });
  }
  if (!opts.dry_run && matches.length) {
    for (const m of matches) await db.query('update transactions set category_id = $2 where id = $1 and category_id is null', [m.id, m.category_id]);
  }
  return {
    dry_run: opts.dry_run,
    total_uncategorized: txRes.rowCount ?? txRes.rows.length,
    matched: matches.length,
    updated: opts.dry_run ? 0 : matches.length,
    sample: matches.slice(0, 15).map(({ category_id: _c, ...m }) => m),
  };
}
