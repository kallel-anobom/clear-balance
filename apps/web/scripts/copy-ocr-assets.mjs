// Copia os arquivos do OCR (Tesseract) para public/ocr, para serem servidos pelo próprio site
// (sem baixar nada de CDN de terceiros). O idioma português fica em public/tessdata.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const out = join(process.cwd(), 'public', 'ocr');
mkdirSync(out, { recursive: true });

const tessDir = dirname(require.resolve('tesseract.js/package.json'));
const coreDir = dirname(require.resolve('tesseract.js-core/package.json'));
cpSync(join(tessDir, 'dist', 'worker.min.js'), join(out, 'worker.min.js'));
for (const f of ['tesseract-core-lstm', 'tesseract-core-simd-lstm', 'tesseract-core-relaxedsimd-lstm']) {
  const src = join(coreDir, `${f}.wasm.js`);
  if (existsSync(src)) cpSync(src, join(out, `${f}.wasm.js`));
}
console.log('Arquivos de OCR copiados para public/ocr');
