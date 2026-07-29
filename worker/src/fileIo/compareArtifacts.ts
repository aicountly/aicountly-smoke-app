import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ArtifactComparison } from './types.js';

export function compareArtifacts(sourcePath: string, resultPath: string): ArtifactComparison {
  const source = fs.readFileSync(sourcePath);
  const result = fs.readFileSync(resultPath);
  const sourceMime = detectMime(sourcePath, source);
  const resultMime = detectMime(resultPath, result);
  const sourceHash = sha256(source);
  const resultHash = sha256(result);
  const checks = structureCheck(sourcePath, source, resultPath, result);
  const exact = sourceHash === resultHash;
  const status = exact && checks.ok ? 'pass' : checks.ok ? 'partial' : 'fail';
  return {
    status,
    source_sha256: sourceHash,
    result_sha256: resultHash,
    source_mime: sourceMime,
    result_mime: resultMime,
    source_bytes: source.length,
    result_bytes: result.length,
    structure_ok: checks.ok,
    structure_notes: exact ? `Exact SHA-256 match. ${checks.notes}` : `Content hash differs. ${checks.notes}`,
  };
}

/**
 * Validate a product-generated export on its own merits. Export contents are
 * dataset-dependent, so comparing them with the manifest fixture would create
 * a false fidelity failure.
 */
export function inspectExportArtifact(resultPath: string, expectedMimes: string[]): ArtifactComparison {
  const result = fs.readFileSync(resultPath);
  const resultMime = detectMime(resultPath, result);
  const mimeExpected = expectedMimes.length === 0 || expectedMimes.includes(resultMime);
  const structure = standaloneStructureCheck(resultPath, result);
  const status = result.length > 0 && mimeExpected && structure.ok ? 'pass' : 'fail';
  return {
    status,
    result_sha256: sha256(result),
    result_mime: resultMime,
    result_bytes: result.length,
    structure_ok: structure.ok,
    structure_notes: [
      'Export validated without source-fixture hash comparison.',
      structure.notes,
      mimeExpected ? 'Result MIME is expected.' : `Result MIME ${resultMime} is outside expected MIME list: ${expectedMimes.join(', ')}.`,
    ].join(' '),
  };
}

export function sha256(value: Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function detectMime(filePath: string, content: Buffer): string {
  if (content.subarray(0, 5).toString('ascii') === '%PDF-') return 'application/pdf';
  if (content.subarray(0, 4).toString('hex') === '504b0304') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  const ext = path.extname(filePath).toLowerCase();
  return ({
    '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown', '.ics': 'text/calendar',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  } as Record<string, string>)[ext] ?? 'application/octet-stream';
}

function structureCheck(sourcePath: string, source: Buffer, resultPath: string, result: Buffer): { ok: boolean; notes: string } {
  const ext = path.extname(sourcePath).toLowerCase();
  if (ext === '.csv') {
    const a = csvShape(source.toString('utf8'));
    const b = csvShape(result.toString('utf8'));
    const headersMatch = a.headers.join('\u0000') === b.headers.join('\u0000');
    return {
      ok: headersMatch && a.rows === b.rows,
      notes: `CSV source=${a.rows} rows/${a.headers.length} columns, result=${b.rows} rows/${b.headers.length} columns; headers ${headersMatch ? 'match' : 'differ'}.`,
    };
  }
  if (ext === '.pdf') {
    const ok = source.subarray(0, 5).toString('ascii') === '%PDF-' && result.subarray(0, 5).toString('ascii') === '%PDF-';
    return { ok, notes: ok ? 'Both artifacts have PDF magic bytes.' : 'One artifact is missing PDF magic bytes.' };
  }
  if (ext === '.xlsx') {
    const sourceWorkbook = isWorkbook(source);
    const resultWorkbook = isWorkbook(result);
    return { ok: sourceWorkbook && resultWorkbook, notes: `Workbook signatures source=${sourceWorkbook}, result=${resultWorkbook}.` };
  }
  if (isTextExtension(ext) && isTextExtension(path.extname(resultPath).toLowerCase())) {
    const same = normalizeText(source.toString('utf8')) === normalizeText(result.toString('utf8'));
    return { ok: same, notes: same ? 'Normalized text matches.' : 'Normalized text differs.' };
  }
  return { ok: source.length > 0 && result.length > 0, notes: 'Both artifacts are non-empty.' };
}

function standaloneStructureCheck(resultPath: string, result: Buffer): { ok: boolean; notes: string } {
  const ext = path.extname(resultPath).toLowerCase();
  if (ext === '.csv') {
    const shape = csvShape(result.toString('utf8'));
    const ok = shape.headers.some((header) => header !== '');
    return { ok, notes: `CSV export has ${shape.rows} rows and ${shape.headers.length} columns.` };
  }
  if (ext === '.pdf') {
    const ok = result.subarray(0, 5).toString('ascii') === '%PDF-';
    return { ok, notes: ok ? 'Export has PDF magic bytes.' : 'Export is missing PDF magic bytes.' };
  }
  if (ext === '.xlsx') {
    const ok = isWorkbook(result);
    return { ok, notes: ok ? 'Export has a workbook signature.' : 'Export is missing a workbook signature.' };
  }
  return { ok: result.length > 0, notes: result.length > 0 ? 'Export is non-empty.' : 'Export is empty.' };
}

function csvShape(value: string): { headers: string[]; rows: number } {
  const lines = normalizeText(value).split('\n').filter(Boolean);
  return { headers: (lines[0] ?? '').split(',').map((item) => item.trim()), rows: Math.max(0, lines.length - 1) };
}

function isWorkbook(value: Buffer): boolean {
  return value.subarray(0, 4).toString('hex') === '504b0304'
    || /<Workbook[\s>]/i.test(value.subarray(0, 4096).toString('utf8'));
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

function isTextExtension(ext: string): boolean {
  return ['.txt', '.md', '.csv', '.ics', '.svg'].includes(ext);
}
