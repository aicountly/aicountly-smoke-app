import { useCallback, useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import * as controllerAccess from '@/lib/controllerAccess';
import type { ControllerApp } from '@/lib/controllerAccess';
import { useAuthStore } from '@/store/auth';

function GridIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="3" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2.25" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2.25" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2.25" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="2.25" />
    </svg>
  );
}

function AppBadge({ name }: { name: string }) {
  return (
    <span className="inline-flex h-5 w-5 items-center justify-center rounded bg-brand-100 text-[10px] font-bold text-brand-700">
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

type AppLauncherProps = {
  initialApps?: ControllerApp[];
};

export function AppLauncher({ initialApps = [] }: AppLauncherProps) {
  const user = useAuthStore((s) => s.user);
  const seedApps = initialApps.length > 0 ? initialApps : (user?.controller_apps ?? []);

  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<ControllerApp[]>(seedApps);
  const [loading, setLoading] = useState(false);
  const [prefetching, setPrefetching] = useState(false);
  const [launchUrls, setLaunchUrls] = useState<Record<string, string>>({});
  const [launchingCode, setLaunchingCode] = useState('');
  const [launchError, setLaunchError] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (seedApps.length > 0) {
      setApps(seedApps);
    }
  }, [seedApps]);

  const prefetchLaunchUrls = useCallback(async (appList: ControllerApp[]) => {
    const targets = appList.filter((app) => app?.code && !app.is_current && app.can_open !== false);
    if (targets.length === 0) {
      setLaunchUrls({});
      return;
    }

    setPrefetching(true);
    try {
      const entries = await Promise.all(
        targets.map(async (app) => {
          try {
            const data = await controllerAccess.getSsoLaunchUrl(app.code);
            return [app.code, data?.redirect_url || ''] as const;
          } catch {
            return [app.code, ''] as const;
          }
        }),
      );
      setLaunchUrls(Object.fromEntries(entries));
    } finally {
      setPrefetching(false);
    }
  }, []);

  const handleToggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next) {
      return;
    }

    setLaunchError('');
    setLoading(true);
    try {
      const data = await controllerAccess.getLauncherApps();
      const nextApps = data?.apps ?? [];
      setApps(nextApps);
      await prefetchLaunchUrls(nextApps);
    } catch (err) {
      const fallbackApps = seedApps;
      setApps(fallbackApps);
      if (fallbackApps.length > 0) {
        await prefetchLaunchUrls(fallbackApps);
      }
      setLaunchError(err instanceof Error ? err.message : 'Could not load controller apps.');
    } finally {
      setLoading(false);
    }
  };

  const openApp = async (app: ControllerApp) => {
    if (!app?.code || app.is_current || app.can_open === false) {
      return;
    }

    setLaunchError('');
    setLaunchingCode(app.code);

    try {
      let redirectUrl = launchUrls[app.code];
      if (!redirectUrl) {
        const data = await controllerAccess.getSsoLaunchUrl(app.code);
        redirectUrl = data?.redirect_url;
      }
      if (!redirectUrl) {
        throw new Error('Console did not return a launch URL.');
      }
      window.open(redirectUrl, '_blank', 'noopener,noreferrer');
      setOpen(false);
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : 'Could not open controller app.');
    } finally {
      setLaunchingCode('');
    }
  };

  const handleTileClick = (event: React.MouseEvent, app: ControllerApp) => {
    if (!app?.code || app.is_current || app.can_open === false) {
      setOpen(false);
      return;
    }

    if (launchUrls[app.code]) {
      setOpen(false);
      return;
    }

    event.preventDefault();
    void openApp(app);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-ink-200 bg-white text-ink-700 shadow-sm transition hover:border-ink-300 hover:bg-ink-50 hover:text-ink-900"
        title="Top Controller Apps"
        aria-label="Top Controller Apps"
        onClick={() => void handleToggle()}
      >
        <GridIcon />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-2 w-80 overflow-hidden rounded-xl border border-ink-200 bg-white shadow-lg">
          <div className="border-b border-ink-100 px-4 py-3 text-sm font-semibold text-ink-800">
            Top Controller Apps
          </div>

          {prefetching ? (
            <div className="mx-3 mt-3 rounded-lg bg-brand-50 px-3 py-2 text-xs text-brand-800">
              Preparing secure launch links…
            </div>
          ) : null}

          {launchError ? (
            <div className="mx-3 mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700">{launchError}</div>
          ) : null}

          {loading ? <div className="px-4 py-6 text-center text-sm text-ink-500">Loading apps…</div> : null}

          {!loading && apps.length === 0 ? (
            <div className="px-4 py-6 text-center text-sm text-ink-500">No controller apps assigned.</div>
          ) : null}

          {!loading && apps.length > 0 ? (
            <div className="grid max-h-[420px] grid-cols-2 gap-2 overflow-y-auto p-3">
              {apps.map((app) => {
                const redirectUrl = launchUrls[app.code];
                const isLocked = app.can_open === false && !app.is_current;
                const isLaunchable = Boolean(app.code && !app.is_current && !isLocked);
                const commonClass = clsx(
                  'flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition',
                  app.is_current
                    ? 'cursor-default border-brand-300 bg-brand-50'
                    : isLocked
                      ? 'cursor-not-allowed border-ink-200 bg-ink-50 opacity-75'
                      : 'border-ink-200 bg-white hover:border-ink-300 hover:bg-ink-50',
                  launchingCode && launchingCode !== app.code ? 'opacity-60' : '',
                );

                if (isLaunchable && redirectUrl) {
                  return (
                    <a
                      key={app.code}
                      href={redirectUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={commonClass}
                      onClick={(event) => handleTileClick(event, app)}
                    >
                      <AppBadge name={app.name} />
                      <p className="m-0 text-sm font-semibold text-ink-900">{app.name}</p>
                      {app.subtitle ? <p className="m-0 text-xs leading-snug text-ink-500">{app.subtitle}</p> : null}
                    </a>
                  );
                }

                return (
                  <button
                    key={app.code}
                    type="button"
                    disabled={Boolean(launchingCode) || app.is_current || isLocked}
                    className={commonClass}
                    onClick={() => void openApp(app)}
                  >
                    <AppBadge name={app.name} />
                    <p className="m-0 text-sm font-semibold text-ink-900">{app.name}</p>
                    {app.subtitle ? <p className="m-0 text-xs leading-snug text-ink-500">{app.subtitle}</p> : null}
                    {launchingCode === app.code ? (
                      <p className="m-0 text-xs text-brand-700">Opening…</p>
                    ) : null}
                    {app.is_current ? <p className="m-0 text-xs font-medium text-brand-700">Current app</p> : null}
                    {isLocked ? <p className="m-0 text-xs text-ink-400">No access</p> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
