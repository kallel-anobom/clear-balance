import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/**
 * Sem as variáveis VITE_SUPABASE_*, o app roda em "modo local" (sem login) — usado só no seu computador,
 * com a API em AUTH_DISABLED=true. Em produção as variáveis são obrigatórias e a API exige o token.
 * A chave "anon" é pública por natureza: os dados ficam protegidos por RLS e pela API.
 */
export const authEnabled = Boolean(url && anonKey);

export const supabase: SupabaseClient | null = authEnabled
  ? createClient(url!, anonKey!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } })
  : null;

/** Token de acesso atual (renovado automaticamente pelo supabase-js), ou null no modo local. */
export async function getAccessToken(): Promise<string | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}
