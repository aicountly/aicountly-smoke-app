import fs from 'node:fs';
import path from 'node:path';
import type { SyntheticDataset } from '../data/syntheticData.js';

const RENDERABLE = new Set(['.csv', '.txt', '.md', '.pdf']);

export function isRenderableExtension(filePath: string): boolean {
  return RENDERABLE.has(path.extname(filePath).toLowerCase());
}

/**
 * Render an AI-supplied dataset into a fixture file. XLSX and other binary
 * formats keep the static template (no spreadsheet dependency in the worker).
 */
export function renderFixture(
  runPath: string,
  dataset: SyntheticDataset,
): { ok: boolean; message: string } {
  const ext = path.extname(runPath).toLowerCase();
  if (!RENDERABLE.has(ext)) {
    return { ok: false, message: `Extension ${ext || '(none)'} is not AI-renderable; using static fixture.` };
  }
  fs.mkdirSync(path.dirname(runPath), { recursive: true });
  if (ext === '.csv') {
    fs.writeFileSync(runPath, toCsv(dataset), 'utf8');
    return { ok: true, message: 'Rendered CSV dataset.' };
  }
  if (ext === '.txt' || ext === '.md') {
    fs.writeFileSync(runPath, toTextTable(dataset), 'utf8');
    return { ok: true, message: `Rendered ${ext.slice(1).toUpperCase()} dataset.` };
  }
  if (ext === '.pdf') {
    fs.writeFileSync(runPath, buildMinimalPdf(dataset));
    return { ok: true, message: 'Rendered minimal PDF dataset.' };
  }
  return { ok: false, message: 'Unsupported render target.' };
}

function toCsv(dataset: SyntheticDataset): string {
  const lines = [dataset.columns.map(csvEscape).join(',')];
  for (const row of dataset.rows) {
    const cells = dataset.columns.map((_, index) => csvEscape(row[index] ?? ''));
    lines.push(cells.join(','));
  }
  return `${lines.join('\n')}\n`;
}

function toTextTable(dataset: SyntheticDataset): string {
  const header = dataset.columns.join(' | ');
  const body = dataset.rows.map((row) => dataset.columns.map((_, i) => row[i] ?? '').join(' | '));
  return [`SMOKE synthetic fixture`, header, '-'.repeat(header.length), ...body, ''].join('\n');
}

function csvEscape(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

/** Minimal single-page PDF with Helvetica text — no external dependency. */
function buildMinimalPdf(dataset: SyntheticDataset): Buffer {
  const lines = [
    'SMOKE synthetic fixture',
    dataset.columns.join(' | '),
    ...dataset.rows.slice(0, 12).map((row) => dataset.columns.map((_, i) => row[i] ?? '').join(' | ')),
  ].map((line) => line.replace(/[^\x20-\x7E]/g, ' ').slice(0, 100));

  const contentLines = ['BT', '/F1 10 Tf', '50 780 Td', '14 TL'];
  lines.forEach((line, index) => {
    const escaped = line.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
    if (index === 0) contentLines.push(`(${escaped}) Tj`);
    else contentLines.push(`T* (${escaped}) Tj`);
  });
  contentLines.push('ET');
  const stream = contentLines.join('\n');

  const objects: string[] = [];
  objects.push('1 0 obj<< /Type /Catalog /Pages 2 0 R >>endobj\n');
  objects.push('2 0 obj<< /Type /Pages /Kids [3 0 R] /Count 1 >>endobj\n');
  objects.push('3 0 obj<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources<< /Font<< /F1 5 0 R >> >> >>endobj\n');
  objects.push(`4 0 obj<< /Length ${Buffer.byteLength(stream, 'utf8')} >>stream\n${stream}\nendstream\nendobj\n`);
  objects.push('5 0 obj<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>endobj\n');

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const object of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf8'));
    pdf += object;
  }
  const xrefStart = Buffer.byteLength(pdf, 'utf8');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i < offsets.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, 'utf8');
}
