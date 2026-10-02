import type { HealthResponse } from '../../../shared/contracts';
import { apiFetch } from './http';

export async function getHealth(): Promise<HealthResponse> {
  if (window.mukai) return window.mukai.getHealth();
  return (
    await apiFetch('/health', { signal: AbortSignal.timeout(3000) })
  ).json() as Promise<HealthResponse>;
}
