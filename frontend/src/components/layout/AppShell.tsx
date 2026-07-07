import { NavLink, Outlet, useLocation } from 'react-router-dom';
import clsx from 'clsx';
import { api } from '@/lib/api';
import { redirectToConsoleLogin } from '@/lib/consoleAuth';
import { useAuthStore } from '@/store/auth';
import { ProductionBanner } from '@/components/layout/ProductionBanner';

const NAV: Array<{ to: string; label: string; roles?: string[] }> = [
  { to: '/dashboard',             label: 'Dashboard' },
  { to: '/profiles',              label: 'Target App Profiles' },
  { to: '/observations/new',      label: 'New Observation', roles: ['owner', 'product_reviewer'] },
  { to: '/runs',                  label: 'Observation Runs' },
  { to: '/reports',               label: 'Reports' },
  { to: '/feature-gap-matrix',    label: 'Feature Gap Matrix' },
  { to: '/competitor-benchmarks', label: 'Competitor Benchmarks', roles: ['owner', 'product_reviewer'] },
  { to: '/settings',              label: 'Settings', roles: ['owner', 'product_reviewer'] },
  { to: '/audit-logs',            label: 'Audit Logs', roles: ['owner', 'product_reviewer', 'auditor_viewer'] },
];

export function AppShell() {
  const user = useAuthStore((s) => s.user);
  const logoutStore = useAuthStore((s) => s.logout);
  const location = useLocation();

  async function logout() {
    try {
      await api.post('/auth/logout');
    } catch {
      /* ignore */
    }
    logoutStore();
    redirectToConsoleLogin();
  }

  return (
    <div className="min-h-screen flex bg-ink-50">
      <aside className="w-64 bg-white border-r border-ink-200 flex flex-col">
        <div className="px-5 py-4 border-b border-ink-200 flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-brand-500 grid place-items-center text-white font-semibold">S</div>
          <div>
            <div className="text-sm font-semibold leading-none">smoke.aicountly</div>
            <div className="text-[11px] text-ink-500">Product Intelligence Portal</div>
          </div>
        </div>
        <nav className="flex-1 py-3">
          {NAV.filter((n) => !n.roles || n.roles.some((r) => user?.roles.includes(r))).map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                clsx(
                  'flex items-center px-5 py-2 text-sm border-l-2',
                  isActive
                    ? 'border-brand-500 bg-brand-50/50 text-brand-800 font-medium'
                    : 'border-transparent text-ink-700 hover:bg-ink-50',
                )
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="px-5 py-4 border-t border-ink-200 text-xs text-ink-500">
          v0.1.0 &middot; observer mode
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-ink-200 flex items-center justify-between px-6">
          <div className="text-sm text-ink-500">{location.pathname}</div>
          <div className="flex items-center gap-3">
            <div className="text-right text-xs leading-tight">
              <div className="font-medium text-ink-800">{user?.full_name ?? 'Guest'}</div>
              <div className="text-ink-500">{user?.roles.join(', ')}</div>
            </div>
            <button className="btn-secondary" onClick={logout}>Sign out</button>
          </div>
        </header>
        <ProductionBanner />
        <main className="flex-1 p-6 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
