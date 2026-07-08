import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type ControllerApp = {
  code: string;
  name: string;
  subtitle?: string;
  icon?: string;
  base_url?: string;
  is_current?: boolean;
  can_open?: boolean;
};

export type SmokeUser = {
  id: number;
  email: string;
  full_name: string;
  roles: string[];
  must_rotate_pw?: boolean;
  controller_apps?: ControllerApp[];
};

type State = {
  accessToken: string | null;
  refreshToken: string | null;
  user: SmokeUser | null;
  setSession: (s: { access_token: string; refresh_token: string; user: SmokeUser }) => void;
  setAccess: (token: string) => void;
  logout: () => void;
  hasRole: (...roles: string[]) => boolean;
};

export const useAuthStore = create<State>()(
  persist(
    (set, get) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      setSession: (s) =>
        set({ accessToken: s.access_token, refreshToken: s.refresh_token, user: s.user }),
      setAccess: (token) => set({ accessToken: token }),
      logout: () => set({ accessToken: null, refreshToken: null, user: null }),
      hasRole: (...roles) => {
        const u = get().user;
        if (!u) return false;
        return roles.some((r) => u.roles.includes(r));
      },
    }),
    {
      name: 'smoke.auth',
      partialize: (s) => ({ accessToken: s.accessToken, refreshToken: s.refreshToken, user: s.user }),
    },
  ),
);
