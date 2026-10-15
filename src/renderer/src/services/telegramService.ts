import type { TelegramAccessInput, TelegramStatus } from '../../../shared/telegram';
import { api } from './http';

export const telegramService = {
  status: () => api<TelegramStatus>('/telegram'),
  connect: (token: string) => api<TelegramStatus>('/telegram/connect', 'POST', { token }),
  pair: () => api<TelegramStatus>('/telegram/pairing', 'POST', {}),
  approve: (userId: number) => api<TelegramStatus>('/telegram/pairing/approve', 'POST', { userId }),
  access: (value: TelegramAccessInput) => api<TelegramStatus>('/telegram/access', 'PUT', value),
  state: (enabled: boolean) => api<TelegramStatus>('/telegram/state', 'PUT', { enabled }),
  disconnect: () => api<TelegramStatus>('/telegram/connection', 'DELETE'),
  revoke: () => api<TelegramStatus>('/telegram/owner', 'DELETE'),
};
