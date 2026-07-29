import type { Page } from 'playwright';

export async function uploadFixture(page: Page, fixturePath: string): Promise<{ ok: boolean; selector?: string; message: string }> {
  const inputs = page.locator('input[type="file"]');
  for (let index = 0; index < await inputs.count(); index++) {
    const input = inputs.nth(index);
    if (await input.isDisabled().catch(() => true)) continue;
    await input.setInputFiles(fixturePath);
    return { ok: true, selector: `input[type=file]:nth(${index})`, message: 'Fixture assigned to file input.' };
  }

  const trigger = page.getByRole('button', { name: /upload|import|attach|choose file/i }).first();
  if (!await trigger.count()) return { ok: false, message: 'No file input or upload/import control was found.' };
  try {
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 5_000 });
    await trigger.click({ timeout: 5_000 });
    const chooser = await chooserPromise;
    await chooser.setFiles(fixturePath);
    return { ok: true, message: 'Fixture assigned through a file chooser.' };
  } catch {
    return { ok: false, message: 'Upload control did not open a file chooser.' };
  }
}
