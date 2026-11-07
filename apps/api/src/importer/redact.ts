/**
 * Anonimização do texto de um extrato ANTES de qualquer envio a um serviço externo.
 * Troca documentos, contatos e números de conta/cartão por marcadores. Valores em reais, datas
 * e nomes de estabelecimentos são mantidos (a interpretação depende deles).
 * Nomes de pessoas (ex.: PIX para "Fulano") não são detectáveis com segurança e seguem no texto.
 */
const RULES: [RegExp, string][] = [
  // Ordem importa: padrões mais específicos primeiro.
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[EMAIL]'],
  [/(?<![\d.,/-])\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}(?![\d,])/g, '[CNPJ]'],
  [/(?<![\d.,/-])\d{3}\.?\d{3}\.?\d{3}-?\d{2}(?![\d,])/g, '[CPF]'],
  // Cartão com 16 dígitos agrupados de 4 em 4 (mantém só mascarados como "**** 1234").
  [/(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,4}(?!\d)/g, '[CARTAO]'],
  // Telefone brasileiro: +55 (11) 91234-5678, 11 91234-5678, (11) 1234-5678.
  [/(?<![\d.,/-])(?:\+?55[ -]?)?\(?\d{2}\)?[ -]?9?\d{4}-\d{4}(?![\d,])/g, '[TEL]'],
  // Agência/conta: "AG 1234 CC 12345-6", "conta: 123456-7".
  [/\b(ag(?:encia|ência)?|c\/c|cc|conta)\.?\s*:?\s*[\dxX][\dxX.\-/]*/gi, '$1 [CONTA]'],
  // Qualquer sequência longa de dígitos (boleto, protocolo, conta, cartão sem separador).
  [/(?<![\d.,])\d{9,}(?![\d,])/g, '[NUM]'],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, repl] of RULES) out = out.replace(re, repl);
  return out;
}
