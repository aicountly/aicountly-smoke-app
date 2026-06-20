import path from 'node:path';
import fs from 'node:fs';
import type { Page } from 'playwright';

export async function captureScreenshot(page: Page, dir: string, name: string): Promise<string> {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100);
  const file = path.join(dir, `${Date.now()}-${safe}.png`);
  await page.screenshot({ path: file, fullPage: true, animations: 'disabled' });
  return file;
}
