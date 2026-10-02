import type { ProviderInput, ProviderSettings, ProviderTestResult } from '../../../shared/ai';
import { api } from './http';

export const providerService = {
  list: () => api<ProviderSettings[]>('/providers'),
  create: (value: ProviderInput) => api<ProviderSettings>('/providers', 'POST', value),
  update: (id: string, value: ProviderInput) =>
    api<ProviderSettings>(`/providers/${encodeURIComponent(id)}`, 'PUT', value),
  remove: (id: string) => api<{ ok: boolean }>(`/providers/${encodeURIComponent(id)}`, 'DELETE'),
  test: (id: string) =>
    api<ProviderTestResult>(`/providers/${encodeURIComponent(id)}/test`, 'POST'),
};
