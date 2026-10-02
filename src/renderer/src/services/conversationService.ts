import type { Conversation, SpaceInput } from '../../../shared/conversations';
import type { ChatMessage } from '../../../shared/ai';
import { api } from './http';

export const conversationService = {
  list: (workspaceId: string) =>
    api<Conversation[]>(`/conversations?workspaceId=${encodeURIComponent(workspaceId)}`),
  create: (workspaceId: string, input: SpaceInput) =>
    api<Conversation>('/conversations', 'POST', { workspaceId, ...input }),
  import: (
    workspaceId: string,
    spaces: {
      id: string;
      name: string;
      description: string;
      messages: { id: string; text: string; author: string; saved: boolean }[];
    }[],
  ) => api<Conversation[]>('/conversations/import', 'POST', { workspaceId, spaces }),
  save: (id: string, messageId: string, saved: boolean) =>
    api<ChatMessage>(`/conversations/${encodeURIComponent(id)}/saved`, 'PUT', { messageId, saved }),
};
