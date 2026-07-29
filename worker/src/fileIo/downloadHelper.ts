import fs from 'node:fs';
import path from 'node:path';
import type { Page } from 'playwright';

export async function downloadArtifact(
  page: Page,
  downloadsDir: string,
  scenarioKey: string,
): Promise<{ ok: boolean; path?: string; message: string }> {
  fs.mkdirSync(downloadsDir, { recursive: true });
  const trigger = page.getByRole('button', { name: /download|export/i }).or(
    page.getByRole('link', { name: /download|export/i }),
  ).first();
  if (!await trigger.count()) return { ok: false, message: 'No download/export control was found.' };
  try {
    const pending = page.waitForEvent('download', { timeout: 10_000 });
    await trigger.click({ timeout: 7_000 });
    const download = await pending;
    const suggested = path.basename(download.suggestedFilename() || `${scenarioKey}.bin`);
    const destination = path.join(downloadsDir, `${safeSegment(scenarioKey)}-${suggested}`);
    await download.saveAs(destination);
    return { ok: true, path: destination, message: 'Download saved.' };
  } catch (error) {
    return { ok: false, message: `Download did not complete: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function safeSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, '-');
}
