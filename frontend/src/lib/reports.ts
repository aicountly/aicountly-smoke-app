import { api } from '@/lib/api';

export async function openReport(id: number, format: 'html' | 'json'): Promise<void> {
  const res = await api.get(`/reports/${id}/${format}`, { responseType: 'text' });
  const mime = format === 'html' ? 'text/html;charset=utf-8' : 'application/json';
  const url = URL.createObjectURL(new Blob([res.data as string], { type: mime }));
  window.open(url, '_blank', 'noopener,noreferrer');
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
