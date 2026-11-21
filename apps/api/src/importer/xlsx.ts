import { inflateRawSync } from 'node:zlib';
import { normalizeText } from '../lib.js';

/**
 * Leitor mínimo de planilha .xlsx (sem dependências): descompacta o zip, lê a primeira aba e devolve um CSV
 * (separador ";"), que segue o mesmo caminho do CSV do banco. Alguns bancos (ex.: fatura do Itaú) só exportam .xlsx.
 */

export class XlsxError extends Error {}

const MAX_ENTRY_BYTES = 20 * 1024 * 1024; // proteção contra zip bomb
const MAX_ENTRIES = 2000;

interface ZipEntry { name: string; method: number; compSize: number; localOffset: number }

function listEntries(buf: Buffer): ZipEntry[] {
  // Fim do diretório central (EOCD): assinatura 0x06054b50, procurada de trás para frente.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65_535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new XlsxError('Arquivo de planilha inválido.');
  const total = buf.readUInt16LE(eocd + 10);
  if (total > MAX_ENTRIES) throw new XlsxError('Planilha com arquivos demais.');
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < total; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('Arquivo de planilha inválido.');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    out.push({ name: buf.toString('utf8', p + 46, p + 46 + nameLen), method, compSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function readEntry(buf: Buffer, e: ZipEntry): string {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new XlsxError('Arquivo de planilha inválido.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
    } catch {
      throw new XlsxError('Não consegui descompactar a planilha.');
    }
  }
  throw new XlsxError('Planilha com compactação não suportada.');
}

/** Planilhas são zip: começam com "PK" e têm xl/workbook.xml. */
export function isXlsx(buf: Buffer): boolean {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) return false;
  try {
    return listEntries(buf).some((e) => e.name === 'xl/workbook.xml');
  } catch {
    return false;
  }
}

const unescapeXml = (s: string) =>
  s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const textOf = (xml: string) => unescapeXml([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

const colIndex = (letters: string) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

/** Número de série do Excel (dias desde 30/12/1899) para AAAA-MM-DD. */
function serialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 36_526 || serial > 73_050) return null; // 2000 a 2099
  return new Date(Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000).toISOString().slice(0, 10);
}

function readGrid(buf: Buffer): { grid: string[][]; numeric: boolean[][] } {
  const entries = listEntries(buf);
  const sheets = entries
    .filter((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(/\d+/.exec(a.name.split('/').pop()!)![0]) - Number(/\d+/.exec(b.name.split('/').pop()!)![0]));
  if (!sheets.length) throw new XlsxError('A planilha não tem nenhuma aba com dados.');

  const sst = entries.find((e) => e.name === 'xl/sharedStrings.xml');
  const strings = sst ? [...readEntry(buf, sst).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1])) : [];

  const xml = readEntry(buf, sheets[0]);
  const grid: string[][] = [];
  const numeric: boolean[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    const isNum: boolean[] = [];
    for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+)\d+"/.exec(c[1]);
      if (!ref) continue;
      const idx = colIndex(ref[1]);
      const type = /\bt="(\w+)"/.exec(c[1])?.[1] ?? 'n';
      const inner = c[2] ?? '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let value = '';
      if (type === 's' && v !== undefined) value = strings[Number(v)] ?? '';
      else if (type === 'inlineStr') value = textOf(inner);
      else if (type === 'str' && v !== undefined) value = unescapeXml(v);
      else if (type === 'n' && v !== undefined) { value = v; isNum[idx] = true; }
      cells[idx] = value;
    }
    if (cells.some((x) => x && x.trim())) { grid.push(Array.from(cells, (x) => x ?? '')); numeric.push(isNum); }
  }
  return { grid, numeric };
}

const csvCell = (s: string) => (/[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

export function xlsxToCsv(buf: Buffer): Buffer {
  const { grid, numeric } = readGrid(buf);

  // Cabeçalho: primeira linha que tem uma coluna de data e uma de valor.
  const headerIdx = grid.slice(0, 30).findIndex((r) => {
    const h = r.map((x) => normalizeText(x ?? ''));
    return h.some((x) => /^(data|date)\b/.test(x)) && h.some((x) => /^(valor|amount)/.test(x));
  });
  const header = headerIdx >= 0 ? grid[headerIdx].map((x) => normalizeText(x ?? '')) : [];
  const dateCols = new Set(header.flatMap((x, i) => (/^(data|date)\b/.test(x) ? [i] : [])));
  const installCol = header.findIndex((x) => x === 'parcelamento');
  const descCol = header.findIndex((x) => x === 'lancamento' || x === 'descricao' || x === 'historico');

  const lines = grid.map((r, ri) => {
    const cells = [...r].map((x, ci) => {
      const raw = x ?? '';
      if (ri > headerIdx && numeric[ri]?.[ci]) {
        const n = Number(raw);
        if (dateCols.has(ci)) return serialToIso(n) ?? raw;
        // Valores com vírgula decimal (como o CSV dos bancos brasileiros); inteiros ficam como estão.
        return Number.isInteger(n) ? String(n) : n.toFixed(2).replace('.', ',');
      }
      return raw.replace(/\s+/g, ' ').trim();
    });
    // A coluna de parcelamento ("Parcela 1 de 3") vira parte da descrição, que é onde o sistema reconhece parcelas.
    if (headerIdx >= 0 && ri > headerIdx && installCol >= 0 && descCol >= 0 && /parcela\s+\d+\s+de\s+\d+/i.test(cells[installCol] ?? '')) {
      cells[descCol] = `${cells[descCol]} ${cells[installCol]}`.trim();
    }
    return cells.map(csvCell).join(';');
  });
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}
