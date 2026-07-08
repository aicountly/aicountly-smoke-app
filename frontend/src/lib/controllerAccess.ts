import { api } from '@/lib/api';

export type ControllerApp = {
  code: string;
  name: string;
  subtitle?: string;
  icon?: string;
  base_url?: string;
  is_current?: boolean;
  can_open?: boolean;
};

export async function getLauncherApps(): Promise<{ apps: ControllerApp[] }> {
  const { data } = await api.get('/auth/controller-apps/launcher');
  return data;
}

export async function getSsoLaunchUrl(appCode: string): Promise<{ redirect_url: string }> {
  const { data } = await api.get('/auth/sso/launch-url', { params: { app_code: appCode } });
  return data;
}
