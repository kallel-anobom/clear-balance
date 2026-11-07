/**
 * Chamada única à API da Anthropic com "tool use" forçado, compartilhada pelo leitor de extratos e pelo resumo do mês.
 * Mensagens de erro e logs nunca incluem o conteúdo enviado nem o corpo da resposta.
 */
export type AiErrorCode = 'no_key' | 'timeout' | 'upstream' | 'auth' | 'rate' | 'too_big' | 'bad_output';

export class AiError extends Error {
  constructor(public code: AiErrorCode, message: string, public status = 502) {
    super(message);
  }
}

export interface ToolCall {
  apiKey: string | undefined;
  model: string;
  system: string;
  user: string;
  tool: { name: string; description: string; input_schema: unknown };
  maxTokens: number;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Textos específicos de cada situação (por exemplo, o que fazer quando o texto é grande demais). */
  messages?: Partial<Record<AiErrorCode, string>>;
}

export interface ToolResult {
  /** `input` da chamada da ferramenta; `undefined` se a IA não chamou a ferramenta. */
  input: unknown;
  usage: { input_tokens: number; output_tokens: number } | null;
}

const API_URL = 'https://api.anthropic.com/v1/messages';

export async function callAnthropicTool(c: ToolCall): Promise<ToolResult> {
  const msg = (code: AiErrorCode, fallback: string) => c.messages?.[code] ?? fallback;
  if (!c.apiKey) throw new AiError('no_key', 'A IA não está configurada no servidor (falta a chave da Anthropic).', 503);
  const doFetch = c.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), c.timeoutMs ?? 25_000);
  let res: Response;
  try {
    res = await doFetch(API_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': c.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: c.model,
        max_tokens: c.maxTokens,
        temperature: 0,
        system: c.system,
        tools: [c.tool],
        tool_choice: { type: 'tool', name: c.tool.name },
        messages: [{ role: 'user', content: c.user }],
      }),
    });
  } catch (e) {
    if ((e as { name?: string }).name === 'AbortError') {
      throw new AiError('timeout', msg('timeout', 'A IA demorou demais para responder. Tente de novo.'), 504);
    }
    throw new AiError('upstream', 'Não consegui falar com a IA. Tente de novo em instantes.', 502);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) throw new AiError('auth', 'A chave da Anthropic foi recusada. Confira a ANTHROPIC_API_KEY.', 502);
  if (res.status === 429) throw new AiError('rate', 'A Anthropic limitou as requisições. Tente de novo em instantes.', 429);
  if (!res.ok) throw new AiError('upstream', `A IA está indisponível agora (erro ${res.status}). Tente de novo mais tarde.`, 502);

  const data = (await res.json().catch(() => null)) as {
    content?: { type: string; name?: string; input?: unknown }[]; stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  } | null;
  if (data?.stop_reason === 'max_tokens') {
    throw new AiError('too_big', msg('too_big', 'A resposta da IA ficou grande demais. Tente de novo.'), 422);
  }
  const block = data?.content?.find((b) => b.type === 'tool_use' && b.name === c.tool.name);
  const usage = data?.usage ? { input_tokens: data.usage.input_tokens ?? 0, output_tokens: data.usage.output_tokens ?? 0 } : null;
  return { input: block?.input, usage };
}
