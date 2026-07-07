import { useCallback, useEffect, useState } from 'react';
import type { AxiosError } from 'axios';
import { api } from '@/lib/api';
import { clearControllerSsoHash, readControllerSsoToken } from '@/lib/controllerSso';
import { useAuthStore } from '@/store/auth';

export const GATE_CONSOLE_REQUIRED = 'console_required';
export const GATE_NO_ACCESS = 'no_access';
export const GATE_ERROR = 'error';

export type GateReason = typeof GATE_CONSOLE_REQUIRED | typeof GATE_NO_ACCESS | typeof GATE_ERROR | null;

type AuthBootstrapState = {
  loading: boolean;
  ssoPending: boolean;
  gateReason: GateReason;
  gateMessage: string;
  retryAuth: () => Promise<void>;
};

function getErrorMessage(error: unknown): string {
  const ax = error as AxiosError<{ message?: string }>;
  return ax.response?.data?.message ?? (error instanceof Error ? error.message : 'Could not sign in via Console');
}

export function useAuthBootstrap(): AuthBootstrapState {
  const accessToken = useAuthStore((s) => s.accessToken);
  const user = useAuthStore((s) => s.user);
  const setSession = useAuthStore((s) => s.setSession);
  const logout = useAuthStore((s) => s.logout);

  const [loading, setLoading] = useState(true);
  const [ssoPending, setSsoPending] = useState(false);
  const [gateReason, setGateReason] = useState<GateReason>(null);
  const [gateMessage, setGateMessage] = useState('');

  const refreshSession = useCallback(async (): Promise<boolean> => {
    if (!accessToken) {
      return false;
    }
    try {
      const { data } = await api.get('/auth/me');
      if (!data?.id) {
        logout();
        return false;
      }
      setGateReason(null);
      setGateMessage('');
      return true;
    } catch {
      logout();
      return false;
    }
  }, [accessToken, logout]);

  const loginWithControllerSso = useCallback(async (ssoToken: string) => {
    const { data } = await api.post('/auth/controller-sso', { token: ssoToken });
    if (!data?.access_token || !data?.refresh_token || !data?.user) {
      throw new Error('Session succeeded but tokens were not returned');
    }
    setSession(data);
    setGateReason(null);
    setGateMessage('');
  }, [setSession]);

  const loginWithConsoleSession = useCallback(async () => {
    const { data } = await api.post('/auth/console-session', {}, { withCredentials: true });
    if (!data?.access_token || !data?.refresh_token || !data?.user) {
      throw new Error('Session succeeded but tokens were not returned');
    }
    setSession(data);
    setGateReason(null);
    setGateMessage('');
  }, [setSession]);

  const bootstrap = useCallback(async () => {
    setLoading(true);
    setGateReason(null);
    setGateMessage('');

    const ssoToken = readControllerSsoToken();
    if (ssoToken) {
      clearControllerSsoHash();
      setSsoPending(true);
      try {
        await loginWithControllerSso(ssoToken);
      } catch (e) {
        setGateReason(GATE_ERROR);
        setGateMessage(getErrorMessage(e));
      } finally {
        setSsoPending(false);
        setLoading(false);
      }
      return;
    }

    if (accessToken && user) {
      const ok = await refreshSession();
      if (ok) {
        setLoading(false);
        return;
      }
    }

    setSsoPending(true);
    try {
      await loginWithConsoleSession();
    } catch (e) {
      const ax = e as AxiosError<{ message?: string }>;
      const status = ax.response?.status;
      const message = getErrorMessage(e);
      if (status === 401) {
        setGateReason(GATE_CONSOLE_REQUIRED);
        setGateMessage(message);
      } else if (status === 403) {
        setGateReason(GATE_NO_ACCESS);
        setGateMessage(message);
      } else {
        setGateReason(GATE_ERROR);
        setGateMessage(message);
      }
    } finally {
      setSsoPending(false);
      setLoading(false);
    }
  }, [accessToken, loginWithConsoleSession, loginWithControllerSso, refreshSession, user]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const retryAuth = useCallback(async () => {
    logout();
    await bootstrap();
  }, [bootstrap, logout]);

  return { loading, ssoPending, gateReason, gateMessage, retryAuth };
}
