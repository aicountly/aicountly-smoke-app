export function asBool(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}
