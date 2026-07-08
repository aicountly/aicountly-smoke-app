export const CONSOLE_WEB_URL = (import.meta.env.VITE_CONSOLE_URL || 'https://console.aicountly.org').replace(/\/$/, '');
export const CONSOLE_API_URL = (import.meta.env.VITE_CONSOLE_API_URL || `${CONSOLE_WEB_URL}/api`).replace(/\/$/, '');

export function consoleLoginUrl(returnOrigin?: string, options: { signOut?: boolean } = {}): string {
  const params = new URLSearchParams();
  if (options.signOut) {
    params.set('signout', '1');
  } else {
    const origin = returnOrigin || window.location.origin;
    if (origin) {
      params.set('return', `${origin}/`);
    }
  }
  const qs = params.toString();
  return `${CONSOLE_WEB_URL}/login${qs ? `?${qs}` : ''}`;
}

export async function signOutViaConsole(): Promise<void> {
  try {
    await fetch(`${CONSOLE_API_URL}/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });
  } catch {
    /* ignore */
  }
}

export function redirectToConsoleLogin(): void {
  window.location.replace(consoleLoginUrl());
}

export async function redirectToConsoleLoginAfterSignOut(): Promise<void> {
  await signOutViaConsole();
  window.location.replace(consoleLoginUrl(undefined, { signOut: true }));
}
