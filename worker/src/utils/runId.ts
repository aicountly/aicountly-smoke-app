/**
 * Worker-local helper that returns a slug derived from a run_code (used in
 * filesystem paths). The canonical run_code is allocated by the backend.
 */
export function runIdSlug(runCode: string): string {
  return runCode.replace(/[^A-Za-z0-9_-]/g, '_');
}
