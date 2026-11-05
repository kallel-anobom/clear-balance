/**
 * Leitura de extratos no navegador: PDF com texto (pdfjs) ou imagem/PDF escaneado (OCR com Tesseract, em português).
 * Nada sai do aparelho: os arquivos nunca são enviados e os dados do OCR são servidos pelo próprio site.
 * Só o TEXTO resultante vai para a API, para ser interpretado e revisado antes de salvar.
 */
export interface Progress { label: string; fraction: number }
export interface Extracted { text: string; origin: 'pdf' | 'ocr' }

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
export const isImageFile = (f: File) => IMAGE_TYPES.includes(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name);
export const isPdfFile = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);

type OcrWorker = {
  recognize: (img: HTMLCanvasElement) => Promise<{ data: { text: string } }>;
  setParameters: (p: Record<string, string>) => Promise<unknown>;
  terminate: () => Promise<unknown>;
  __label?: (s: string) => void;
};

async function createOcr(onProgress: (p: Progress) => void): Promise<OcrWorker> {
  const { createWorker } = await import('tesseract.js');
  const base = window.location.origin;
  let current = 'Lendo imagem';
  const worker = await createWorker('por', 1, {
    workerPath: `${base}/ocr/worker.min.js`,
    corePath: `${base}/ocr`,
    langPath: `${base}/tessdata`,
    gzip: false,
    logger: (m: { status: string; progress: number }) => {
      if (m.status === 'recognizing text') onProgress({ label: current, fraction: m.progress });
    },
  } as never);
  await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' } as never);
  const ocr = worker as unknown as OcrWorker;
  ocr.__label = (s: string) => { current = s; };
  return ocr;
}

/** Prepara a imagem para o OCR: amplia prints pequenos, escala de cinza, contraste e fundo escuro invertido. */
export function preprocess(source: CanvasImageSource, width: number, height: number): HTMLCanvasElement {
  const targetW = Math.min(3600, Math.max(1800, width));
  const scale = targetW / width;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);

  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < d.length; i += 4) {
    const g = Math.round(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]++;
    sum += g;
  }
  const total = d.length / 4;
  const dark = sum / total < 115; // print em modo escuro: texto claro sobre fundo escuro
  let lo = 0, hi = 255, acc = 0;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= total * 0.01) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= total * 0.01) { hi = v; break; } }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    let g = Math.min(255, Math.max(0, ((d[i] - lo) * 255) / range));
    if (dark) g = 255 - g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

interface TextItem { str: string; transform: number[] }

/** Junta os pedaços de texto do PDF em linhas (mesma altura), da esquerda para a direita. */
export function itemsToLines(items: TextItem[]): string {
  const rows: { y: number; parts: { x: number; s: string }[] }[] = [];
  for (const it of items) {
    if (!it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5];
    const row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
    if (row) row.parts.push({ x, s: it.str });
    else rows.push({ y, parts: [{ x, s: it.str }] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.s.trim()).join(' ')).join('\n');
}

async function loadBitmap(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file);
  } catch {
    throw new Error(`Não consegui abrir a imagem "${file.name}".`);
  }
}

export async function extractFromFiles(files: File[], onProgress: (p: Progress) => void): Promise<Extracted> {
  if (!files.length) throw new Error('Escolha ao menos um arquivo.');
  let ocr = null as OcrWorker | null;
  const getOcr = async () => {
    onProgress({ label: 'Preparando leitor de imagens (OCR)', fraction: 0 });
    return (ocr ??= await createOcr(onProgress));
  };
  const parts: string[] = [];
  let usedOcr = false;

  try {
    for (const [fi, file] of files.entries()) {
      const tag = files.length > 1 ? ` (${fi + 1}/${files.length})` : '';
      if (isImageFile(file)) {
        const w = await getOcr();
        w.__label?.(`Lendo imagem${tag}`);
        const bmp = await loadBitmap(file);
        const canvas = preprocess(bmp, bmp.width, bmp.height);
        bmp.close();
        parts.push((await w.recognize(canvas)).data.text);
        usedOcr = true;
      } else if (isPdfFile(file)) {
        const pdfjs = await import('pdfjs-dist');
        const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
        let doc;
        try {
          doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
        } catch (e) {
          if ((e as Error).name === 'PasswordException') {
            throw new Error('O PDF está protegido por senha. Remova a proteção no seu leitor de PDF e envie de novo — o sistema não pede nem guarda senhas.');
          }
          throw new Error(`Não foi possível ler o PDF "${file.name}".`);
        }
        for (let p = 1; p <= doc.numPages; p++) {
          onProgress({ label: `Lendo PDF${tag}, página ${p}/${doc.numPages}`, fraction: p / doc.numPages });
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          const text = itemsToLines(content.items as TextItem[]);
          if (text.replace(/\s/g, '').length >= 30) {
            parts.push(text);
            continue;
          }
          // Página sem texto (PDF escaneado): desenha a página e usa OCR.
          const viewport = page.getViewport({ scale: 2.5 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvas, viewport }).promise;
          const w = await getOcr();
          w.__label?.(`Lendo página ${p}/${doc.numPages} do PDF escaneado${tag}`);
          parts.push((await w.recognize(preprocess(canvas, canvas.width, canvas.height))).data.text);
          usedOcr = true;
        }
        await (doc as unknown as { destroy?: () => Promise<void> }).destroy?.();
      } else {
        throw new Error(`Formato não suportado: "${file.name}". Use PDF, PNG, JPG ou WebP.`);
      }
    }
  } finally {
    await ocr?.terminate().catch(() => undefined);
  }
  return { text: parts.join('\n'), origin: usedOcr ? 'ocr' : 'pdf' };
}
