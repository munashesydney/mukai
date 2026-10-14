import type { NotificationInbox } from '../../../shared/notifications';
import type { Conversation } from '../../../shared/conversations';
import { api } from './http';

const root = (workspaceId: string, id?: string, action?: string) =>
  `/notifications${id ? '/' + encodeURIComponent(id) : ''}${action ? '/' + action : ''}?workspaceId=${encodeURIComponent(workspaceId)}`;
export const notificationService = {
  list: (workspaceId: string, offset = 0) =>
    api<NotificationInbox>(root(workspaceId) + `&offset=${offset}`),
  mark: (workspaceId: string, id: string, action: 'read' | 'dismiss') =>
    api<{ ok: boolean }>(root(workspaceId, id, action), 'POST'),
  dismissAll: (workspaceId: string) =>
    api<{ ok: boolean }>(root(workspaceId, 'dismiss-all'), 'POST'),
  continue: (workspaceId: string, id: string) =>
    api<Conversation>(root(workspaceId, id, 'continue'), 'POST'),
};
