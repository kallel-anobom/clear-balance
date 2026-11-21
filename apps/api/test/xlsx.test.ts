import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/importer/csv.js';
import { suggest } from '../src/importer/classify.js';
import { isXlsx, xlsxToCsv, XlsxError } from '../src/importer/xlsx.js';

// ---- zip mínimo só para o teste (método 0 = sem compactação, 8 = deflate) ----
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (b: Buffer) => {
  let c = 0xffffffff;
  for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

function makeZip(files: Record<string, string>, deflate = false): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? deflateRawSync(raw) : raw;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(crc32(raw), 14); lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(crc32(raw), 16); ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + data.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(central.length / 2, 8); eocd.writeUInt16LE(central.length / 2, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

// Planilha fictícia no formato da fatura exportada por bancos: linhas de identificação, cabeçalho no meio,
// data como número de série do Excel, coluna de parcelamento separada e rodapé com texto longo.
const STRINGS = [
  'Nome', 'Titular Ficticio', 'Data', 'Lançamento', 'Parcelamento', 'Valor', // 0-5
  'Pagamento Debito Automatico', 'Mercado Exemplo', 'Loja Exemplo', 'Parcela 1 de 3', 'Estorno & Credito', // 6-10
  'Importante saber: texto longo de rodapé sem data nem valor.', // 11
];
const SHARED = `<?xml version="1.0"?><sst>${STRINGS.map((s) => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')}</sst>`;
// 46335 = 2026-11-09, 46344 = 2026-11-18
const SHEET = `<?xml version="1.0"?><worksheet><sheetData>
<row r="1"><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>
<row r="2"></row>
<row r="3"><c r="B3" t="s"><v>2</v></c><c r="C3" t="s"><v>3</v></c><c r="D3" t="s"><v>4</v></c><c r="E3" t="s"><v>5</v></c></row>
<row r="4"><c r="B4"><v>46335</v></c><c r="C4" t="s"><v>6</v></c><c r="E4"><v>-1000.5</v></c></row>
<row r="5"><c r="B5"><v>46344</v></c><c r="C5" t="s"><v>7</v></c><c r="E5"><v>150</v></c></row>
<row r="6"><c r="B6"><v>46344</v></c><c r="C6" t="s"><v>8</v></c><c r="D6" t="s"><v>9</v></c><c r="E6"><v>202.78</v></c></row>
<row r="7"><c r="B7"><v>46344</v></c><c r="C7" t="s"><v>10</v></c><c r="E7"><v>-33.25</v></c></row>
<row r="9"><c r="B9" t="s"><v>11</v></c></row>
</sheetData></worksheet>`;
const FILES = { 'xl/workbook.xml': '<workbook/>', 'xl/sharedStrings.xml': SHARED, 'xl/worksheets/sheet1.xml': SHEET };

describe('leitura de planilha .xlsx', () => {
  for (const deflate of [false, true]) {
    it(`converte para CSV e segue o caminho do CSV (zip ${deflate ? 'compactado' : 'sem compactação'})`, () => {
      const xlsx = makeZip(FILES, deflate);
      expect(isXlsx(xlsx)).toBe(true);
      const r = parseCsv(xlsxToCsv(xlsx), { kind: 'card' });
      expect(r.needs_mapping).toBe(false);
      expect(r.rows.map((x) => [x.date, x.description, x.direction, x.abs_cents])).toEqual([
        ['2026-11-09', 'Pagamento Debito Automatico', 'in', 100050],
        ['2026-11-18', 'Mercado Exemplo', 'out', 15000],
        ['2026-11-18', 'Loja Exemplo Parcela 1 de 3', 'out', 20278], // parcelamento vai para a descrição
        ['2026-11-18', 'Estorno & Credito', 'in', 3325],
      ]);
      // O rodapé sem data/valor não vira lançamento.
      expect(r.rows).toHaveLength(4);
    });
  }

  it('o débito automático dentro da fatura é ignorado e o líquido bate com o do banco', () => {
    const r = parseCsv(xlsxToCsv(makeZip(FILES)), { kind: 'card' });
    let net = 0;
    for (const row of r.rows) {
      const s = suggest({ description: row.description, direction: row.direction, kind: 'card', ownNames: [] });
      if (s.skip_by_default) continue;
      net += row.direction === 'out' ? row.abs_cents : -row.abs_cents;
    }
    expect(net).toBe(15000 + 20278 - 3325);
  });

  it('CSV e PDF não são tratados como planilha, e arquivo quebrado dá erro claro', () => {
    expect(isXlsx(Buffer.from('date,title,amount\n2026-11-02,Padaria,25.90\n'))).toBe(false);
    expect(isXlsx(Buffer.from('%PDF-1.7 ...'))).toBe(false);
    const semAba = makeZip({ 'xl/workbook.xml': '<workbook/>' });
    expect(() => xlsxToCsv(semAba)).toThrow(XlsxError);
  });
});
