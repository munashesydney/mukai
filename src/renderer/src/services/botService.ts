import type { Bot, BotInput } from '../../../shared/ai';
import { api } from './http';

export const botService = {
  list: () => api<Bot[]>('/bots'),
  create: (value: BotInput) => api<Bot>('/bots', 'POST', value),
  update: (id: string, value: BotInput) =>
    api<Bot>(`/bots/${encodeURIComponent(id)}`, 'PUT', value),
  remove: (id: string) => api<{ ok: boolean }>(`/bots/${encodeURIComponent(id)}`, 'DELETE'),
};
