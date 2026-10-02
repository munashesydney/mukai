import type { Bot, BotInput } from '../../../shared/ai';
import { api } from './http';

export const botService = {
  list: (workspaceId = 'default') =>
    api<Bot[]>(`/bots?workspaceId=${encodeURIComponent(workspaceId)}`),
  create: (value: BotInput, workspaceId = 'default') =>
    api<Bot>('/bots', 'POST', { ...value, workspaceId }),
  update: (id: string, value: BotInput) =>
    api<Bot>(`/bots/${encodeURIComponent(id)}`, 'PUT', value),
  remove: (id: string) => api<{ ok: boolean }>(`/bots/${encodeURIComponent(id)}`, 'DELETE'),
};
