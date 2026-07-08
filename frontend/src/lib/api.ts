import axios, { type AxiosError, type AxiosRequestConfig } from 'axios';
import { useAuthStore } from '@/store/auth';

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api/v1';

export const api = axios.create({
  baseURL,
  timeout: 60_000,
  withCredentials: true,
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

let refreshing: Promise<string | null> | null = null;

api.interceptors.response.use(
  (r) => r,
  async (error: AxiosError) => {
    const original = error.config as AxiosRequestConfig & { __retried?: boolean } | undefined;
    const status = error.response?.status;
    const auth = useAuthStore.getState();
    if (status === 401 && original && !original.__retried && auth.refreshToken) {
      original.__retried = true;
      try {
        refreshing ??= (async () => {
          const r = await axios.post(`${baseURL}/auth/refresh`, { refresh_token: auth.refreshToken });
          const newAccess = r.data?.access_token as string | undefined;
          if (newAccess) {
            useAuthStore.getState().setAccess(newAccess);
            return newAccess;
          }
          return null;
        })();
        const newAccess = await refreshing;
        refreshing = null;
        if (newAccess) {
          original.headers = original.headers ?? {};
          (original.headers as Record<string, string>).Authorization = `Bearer ${newAccess}`;
          return api.request(original);
        }
      } catch {
        refreshing = null;
        useAuthStore.getState().logout();
      }
    }
    if (status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);
